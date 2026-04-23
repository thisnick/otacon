package com.otacon.kiosk;

import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.util.Log;

/**
 * Receives incoming SMS messages when this app is the default SMS app.
 * Inserts each message into the system Telephony.Sms.Inbox provider so
 * the existing `otacon sms list / read` commands work unchanged.
 */
public class SmsReceiver extends BroadcastReceiver {
    private static final String TAG = "SmsReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_DELIVER_ACTION.equals(intent.getAction())) {
            return;
        }

        SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (messages == null || messages.length == 0) return;

        // Concatenate multipart message bodies
        StringBuilder body = new StringBuilder();
        String address = null;
        long timestamp = 0;
        for (SmsMessage msg : messages) {
            if (address == null) address = msg.getOriginatingAddress();
            if (timestamp == 0) timestamp = msg.getTimestampMillis();
            body.append(msg.getMessageBody());
        }

        Log.i(TAG, "SMS received from " + address + " (" + body.length() + " chars)");

        // Insert into the system SMS provider so content://sms queries work
        ContentValues values = new ContentValues();
        values.put(Telephony.Sms.ADDRESS, address);
        values.put(Telephony.Sms.BODY, body.toString());
        values.put(Telephony.Sms.DATE, timestamp);
        values.put(Telephony.Sms.READ, 0);
        values.put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX);

        try {
            context.getContentResolver().insert(Telephony.Sms.Inbox.CONTENT_URI, values);
        } catch (Exception e) {
            Log.e(TAG, "Failed to insert SMS: " + e.getMessage());
        }
    }
}
