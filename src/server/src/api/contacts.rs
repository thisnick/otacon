use axum::extract::Query;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::adb::{adb_shell, parse_content_row};
use super::ApiError;

#[derive(Serialize)]
pub struct Contact {
    name: String,
    phones: Vec<String>,
}

#[derive(Deserialize)]
pub struct ContactsQuery {
    pub q: Option<String>,
}

pub async fn handler(Query(query): Query<ContactsQuery>) -> Result<Json<Vec<Contact>>, ApiError> {
    let out = if let Some(ref q) = query.q {
        // Filter by name
        adb_shell(&format!(
            "content query --uri content://com.android.contacts/data --projection display_name:data1 --where \"mimetype='vnd.android.cursor.item/phone_v2' AND display_name LIKE '%{}%'\"",
            q.replace('\'', "''")
        )).await?
    } else {
        adb_shell(
            "content query --uri content://com.android.contacts/data --projection display_name:data1 --where \"mimetype='vnd.android.cursor.item/phone_v2'\""
        ).await?
    };

    // Group phones by name
    let mut by_name: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for line in out.lines() {
        if let Some(row) = parse_content_row(line) {
            let name = row.get("display_name").cloned().unwrap_or_default();
            let phone = row.get("data1").cloned().unwrap_or_default();
            if !name.is_empty() && !phone.is_empty() {
                by_name.entry(name).or_default().push(phone);
            }
        }
    }

    let contacts: Vec<Contact> = by_name
        .into_iter()
        .map(|(name, phones)| Contact { name, phones })
        .collect();

    Ok(Json(contacts))
}
