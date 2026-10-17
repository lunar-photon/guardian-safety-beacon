package com.lunarphoton.stratus;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class OfflineStorage extends SQLiteOpenHelper {

    private static final String DB_NAME = "stratus_offline.db";
    private static final int DB_VERSION = 1;
    private static final String TABLE = "offline_pings";

    public static class PingRecord {
        public final long id;
        public final JSONObject json;

        public PingRecord(long id, JSONObject json) {
            this.id = id;
            this.json = json;
        }
    }

    public OfflineStorage(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "ts REAL, " +
                "lat REAL, " +
                "lon REAL, " +
                "accuracy REAL, " +
                "speed REAL, " +
                "heading REAL, " +
                "battery INTEGER, " +
                "wifi TEXT, " +
                "bluetooth TEXT, " +
                "extra TEXT" +
                ")");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        try {
            db.execSQL("ALTER TABLE " + TABLE + " ADD COLUMN bluetooth TEXT");
        } catch (Exception ignored) {}
        try {
            db.execSQL("ALTER TABLE " + TABLE + " ADD COLUMN extra TEXT");
        } catch (Exception ignored) {}
    }

    public synchronized void savePing(JSONObject p) {
        if (p == null) return;
        try {
            SQLiteDatabase db = getWritableDatabase();
            ContentValues cv = new ContentValues();
            cv.put("ts", p.optDouble("ts", System.currentTimeMillis() / 1000.0));
            if (p.has("lat")) cv.put("lat", p.optDouble("lat"));
            if (p.has("lon")) cv.put("lon", p.optDouble("lon"));
            if (p.has("accuracy")) cv.put("accuracy", (float) p.optDouble("accuracy"));
            if (p.has("speed")) cv.put("speed", (float) p.optDouble("speed"));
            if (p.has("heading")) cv.put("heading", (float) p.optDouble("heading"));
            cv.put("battery", p.optInt("battery", -1));
            JSONArray w = p.optJSONArray("wifi");
            if (w != null) cv.put("wifi", w.toString());
            JSONArray b = p.optJSONArray("bluetooth");
            if (b != null) cv.put("bluetooth", b.toString());
            JSONObject ex = p.optJSONObject("extra");
            if (ex != null) cv.put("extra", ex.toString());

            db.insert(TABLE, null, cv);
            purgeOlderThan3Days();
        } catch (Exception ignored) {}
    }

    public synchronized void purgeOlderThan3Days() {
        try {
            SQLiteDatabase db = getWritableDatabase();
            double cutoff = (System.currentTimeMillis() / 1000.0) - (3 * 86400.0);
            db.delete(TABLE, "ts < ?", new String[]{String.valueOf(cutoff)});
        } catch (Exception ignored) {}
    }

    public synchronized List<PingRecord> getPendingPings(int limit) {
        List<PingRecord> list = new ArrayList<>();
        Cursor c = null;
        try {
            SQLiteDatabase db = getReadableDatabase();
            c = db.query(TABLE, null, null, null, null, null, "ts ASC", String.valueOf(limit));
            if (c != null && c.moveToFirst()) {
                do {
                    long id = c.getLong(c.getColumnIndexOrThrow("id"));
                    double ts = c.getDouble(c.getColumnIndexOrThrow("ts"));
                    JSONObject obj = new JSONObject();
                    obj.put("ts", ts);
                    if (!c.isNull(c.getColumnIndexOrThrow("lat"))) {
                        obj.put("lat", c.getDouble(c.getColumnIndexOrThrow("lat")));
                    }
                    if (!c.isNull(c.getColumnIndexOrThrow("lon"))) {
                        obj.put("lon", c.getDouble(c.getColumnIndexOrThrow("lon")));
                    }
                    if (!c.isNull(c.getColumnIndexOrThrow("accuracy"))) {
                        obj.put("accuracy", c.getFloat(c.getColumnIndexOrThrow("accuracy")));
                    }
                    if (!c.isNull(c.getColumnIndexOrThrow("speed"))) {
                        obj.put("speed", c.getFloat(c.getColumnIndexOrThrow("speed")));
                    }
                    if (!c.isNull(c.getColumnIndexOrThrow("heading"))) {
                        obj.put("heading", c.getFloat(c.getColumnIndexOrThrow("heading")));
                    }
                    obj.put("battery", c.getInt(c.getColumnIndexOrThrow("battery")));

                    int wCol = c.getColumnIndex("wifi");
                    if (wCol != -1 && !c.isNull(wCol)) {
                        String wStr = c.getString(wCol);
                        if (wStr != null && !wStr.isEmpty()) {
                            try { obj.put("wifi", new JSONArray(wStr)); } catch (Exception ignored) {}
                        }
                    }

                    int bCol = c.getColumnIndex("bluetooth");
                    if (bCol != -1 && !c.isNull(bCol)) {
                        String bStr = c.getString(bCol);
                        if (bStr != null && !bStr.isEmpty()) {
                            try { obj.put("bluetooth", new JSONArray(bStr)); } catch (Exception ignored) {}
                        }
                    }

                    int exCol = c.getColumnIndex("extra");
                    if (exCol != -1 && !c.isNull(exCol)) {
                        String exStr = c.getString(exCol);
                        if (exStr != null && !exStr.isEmpty()) {
                            try { obj.put("extra", new JSONObject(exStr)); } catch (Exception ignored) {}
                        }
                    }
                    list.add(new PingRecord(id, obj));
                } while (c.moveToNext());
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return list;
    }

    public synchronized void deletePings(List<Long> ids) {
        if (ids == null || ids.isEmpty()) return;
        try {
            SQLiteDatabase db = getWritableDatabase();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < ids.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append(ids.get(i));
            }
            db.execSQL("DELETE FROM " + TABLE + " WHERE id IN (" + sb.toString() + ")");
        } catch (Exception ignored) {}
    }

    public synchronized int count() {
        Cursor c = null;
        try {
            SQLiteDatabase db = getReadableDatabase();
            c = db.rawQuery("SELECT COUNT(*) FROM " + TABLE, null);
            if (c != null && c.moveToFirst()) {
                return c.getInt(0);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return 0;
    }
}
