package com.otacon.kiosk;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Manages Google OAuth2 lifecycle:
 * - Stores client credentials (from user's Google Cloud project)
 * - Handles auth code flow via local redirect server
 * - Stores and refreshes tokens
 */
public class GoogleAuth {
    private static final String TAG = "OtaconGoogleAuth";
    private static final String PREFS_NAME = "google_auth";
    private static final String TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
    private static final int CALLBACK_PORT = 8089;
    private static final String REDIRECT_URI = "http://127.0.0.1:" + CALLBACK_PORT + "/callback";

    private final Context context;
    private final SharedPreferences prefs;

    public GoogleAuth(Context context) {
        this.context = context;
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    // --- Credentials ---

    public void storeCredentials(String clientId, String clientSecret) {
        prefs.edit()
            .putString("client_id", clientId)
            .putString("client_secret", clientSecret)
            .apply();
        Log.i(TAG, "Credentials stored for client: " + clientId);
    }

    public boolean hasCredentials() {
        return prefs.contains("client_id");
    }

    private String getClientId() {
        return prefs.getString("client_id", null);
    }

    private String getClientSecret() {
        return prefs.getString("client_secret", null);
    }

    // --- Accounts ---

    public String[] getAccounts() {
        AccountManager am = AccountManager.get(context);
        Account[] accounts = am.getAccountsByType("com.google");
        String[] emails = new String[accounts.length];
        for (int i = 0; i < accounts.length; i++) {
            emails[i] = accounts[i].name;
        }
        return emails;
    }

    // --- Token ---

    /**
     * Get an access token for the given account and scope.
     * Returns a JSONObject with either:
     *   {"token": "ya29...", "expires_in": 3600}
     *   {"auth_url": "https://..."} if consent needed (first time)
     *   {"error": "..."} on failure
     */
    public JSONObject getToken(String account, String scope) {
        try {
            String clientId = getClientId();
            String clientSecret = getClientSecret();
            if (clientId == null || clientSecret == null) {
                return errorJson("OAuth credentials not configured — run 'otacon google setup'");
            }

            // Check for stored refresh token
            String refreshKey = "refresh_" + account + "_" + scope;
            String refreshToken = prefs.getString(refreshKey, null);

            if (refreshToken != null) {
                // Use refresh token to get access token
                JSONObject result = refreshAccessToken(clientId, clientSecret, refreshToken);
                if (result.has("token")) {
                    return result;
                }
                // Refresh failed — clear it and re-auth
                Log.w(TAG, "Refresh token expired, re-authenticating");
                prefs.edit().remove(refreshKey).apply();
            }

            // No refresh token — need to do auth flow
            // Start local server to capture callback, then open Chrome
            return doAuthFlow(account, scope, clientId, clientSecret);

        } catch (Exception e) {
            Log.e(TAG, "getToken failed", e);
            return errorJson(e.getMessage());
        }
    }

    // --- Auth flow ---

    private JSONObject doAuthFlow(String account, String scope, String clientId, String clientSecret) throws Exception {
        String authUrl = "https://accounts.google.com/o/oauth2/v2/auth"
            + "?client_id=" + URLEncoder.encode(clientId, "UTF-8")
            + "&redirect_uri=" + URLEncoder.encode(REDIRECT_URI, "UTF-8")
            + "&response_type=code"
            + "&scope=" + URLEncoder.encode(scope, "UTF-8")
            + "&access_type=offline"
            + "&prompt=consent"
            + "&login_hint=" + URLEncoder.encode(account, "UTF-8");

        Log.i(TAG, "Starting auth flow for " + account + " scope=" + scope);

        // Start local callback server in a thread
        final String[] authCode = {null};
        final Exception[] serverError = {null};

        Thread serverThread = new Thread(() -> {
            try (ServerSocket server = new ServerSocket(CALLBACK_PORT)) {
                server.setSoTimeout(60000); // 60s timeout
                Socket client = server.accept();
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(client.getInputStream()));
                String requestLine = reader.readLine();

                // Parse code from: GET /callback?code=xxx&scope=... HTTP/1.1
                if (requestLine != null && requestLine.contains("code=")) {
                    String query = requestLine.split(" ")[1]; // /callback?code=...
                    for (String param : query.substring(query.indexOf('?') + 1).split("&")) {
                        if (param.startsWith("code=")) {
                            authCode[0] = java.net.URLDecoder.decode(
                                param.substring(5), "UTF-8");
                            break;
                        }
                    }
                }

                // Send response to browser
                String body = "<html><body><h2>Authorization complete</h2>"
                    + "<p>You can close this tab.</p></body></html>";
                String response = "HTTP/1.1 200 OK\r\n"
                    + "Content-Type: text/html\r\n"
                    + "Content-Length: " + body.length() + "\r\n"
                    + "Connection: close\r\n\r\n" + body;
                client.getOutputStream().write(response.getBytes());
                client.close();
            } catch (Exception e) {
                serverError[0] = e;
            }
        });
        serverThread.start();

        // Open Chrome with the auth URL
        android.content.Intent intent = new android.content.Intent(
            android.content.Intent.ACTION_VIEW, android.net.Uri.parse(authUrl));
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);

        // Wait for callback
        serverThread.join(65000);

        if (serverError[0] != null) {
            return errorJson("Auth callback server error: " + serverError[0].getMessage());
        }
        if (authCode[0] == null) {
            return errorJson("No auth code received (timeout or user cancelled)");
        }

        Log.i(TAG, "Got auth code, exchanging for tokens");

        // Exchange code for tokens
        return exchangeCodeForTokens(clientId, clientSecret, authCode[0], account, scope);
    }

    // --- Token exchange ---

    private JSONObject exchangeCodeForTokens(String clientId, String clientSecret,
            String code, String account, String scope) throws Exception {
        String body = "code=" + URLEncoder.encode(code, "UTF-8")
            + "&client_id=" + URLEncoder.encode(clientId, "UTF-8")
            + "&client_secret=" + URLEncoder.encode(clientSecret, "UTF-8")
            + "&redirect_uri=" + URLEncoder.encode(REDIRECT_URI, "UTF-8")
            + "&grant_type=authorization_code";

        JSONObject response = httpPost(TOKEN_ENDPOINT, body);

        if (response.has("access_token")) {
            String accessToken = response.getString("access_token");
            int expiresIn = response.optInt("expires_in", 3600);

            // Store refresh token if provided
            if (response.has("refresh_token")) {
                String refreshToken = response.getString("refresh_token");
                String refreshKey = "refresh_" + account + "_" + scope;
                prefs.edit().putString(refreshKey, refreshToken).apply();
                Log.i(TAG, "Refresh token stored for " + account);
            }

            JSONObject result = new JSONObject();
            result.put("token", accessToken);
            result.put("expires_in", expiresIn);
            return result;
        }

        return errorJson("Token exchange failed: " + response.toString());
    }

    private JSONObject refreshAccessToken(String clientId, String clientSecret,
            String refreshToken) {
        try {
            String body = "refresh_token=" + URLEncoder.encode(refreshToken, "UTF-8")
                + "&client_id=" + URLEncoder.encode(clientId, "UTF-8")
                + "&client_secret=" + URLEncoder.encode(clientSecret, "UTF-8")
                + "&grant_type=refresh_token";

            JSONObject response = httpPost(TOKEN_ENDPOINT, body);

            if (response.has("access_token")) {
                JSONObject result = new JSONObject();
                result.put("token", response.getString("access_token"));
                result.put("expires_in", response.optInt("expires_in", 3600));
                return result;
            }

            return errorJson("Refresh failed: " + response.toString());
        } catch (Exception e) {
            return errorJson("Refresh error: " + e.getMessage());
        }
    }

    // --- HTTP helper ---

    private static JSONObject httpPost(String urlStr, String body) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");

        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.getBytes(StandardCharsets.UTF_8));
        }

        int code = conn.getResponseCode();
        InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        BufferedReader reader = new BufferedReader(new InputStreamReader(is));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) sb.append(line);

        return new JSONObject(sb.toString());
    }

    private static JSONObject errorJson(String message) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("error", message);
            return obj;
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
