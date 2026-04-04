import sqlite3
import os

DB_PATH = "users.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users
                 (discord_id TEXT PRIMARY KEY, 
                  century_user TEXT, 
                  century_pass TEXT, 
                  is_redeemed BOOLEAN DEFAULT 0, 
                  is_locked BOOLEAN DEFAULT 0,
                  century_name TEXT)''')
    
    # Migration: Add century_name if table exists but column doesn't
    try:
        c.execute("ALTER TABLE users ADD COLUMN century_name TEXT")
    except sqlite3.OperationalError:
        pass # Column already exists
    
    conn.commit()
    conn.close()

def get_user(discord_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE discord_id=?", (str(discord_id),))
    user = c.fetchone()
    conn.close()
    return user

def redeem_user(discord_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT OR IGNORE INTO users (discord_id, is_redeemed) VALUES (?, 1)", (str(discord_id),))
    c.execute("UPDATE users SET is_redeemed=1 WHERE discord_id=?", (str(discord_id),))
    conn.commit()
    conn.close()

def update_credentials(discord_id, username, password, name):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE users SET century_user=?, century_pass=?, is_locked=1, century_name=? WHERE discord_id=?", 
              (username, password, name, str(discord_id)))
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
    print("Database initialized.")
