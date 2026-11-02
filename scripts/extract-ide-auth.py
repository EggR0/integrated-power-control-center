import sqlite3
import base64
import re
import json
import os

def extract_auth():
    candidates = [
        os.path.expandvars(r'%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb'),
        os.path.expandvars(r'%APPDATA%\Antigravity\User\globalStorage\state.vscdb'),
    ]
    
    for db in candidates:
        if not os.path.exists(db):
            continue
        try:
            con = sqlite3.connect(db)
            cur = con.cursor()
            
            email = None
            access_token = None
            refresh_token = None
            
            # 1. Try modern Antigravity IDE userStatus
            cur.execute("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.userStatus'")
            r = cur.fetchone()
            if r and r[0]:
                try:
                    dec = base64.b64decode(r[0])
                    emails = re.findall(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+', dec.decode('latin1'))
                    if emails:
                        email = emails[0]
                except:
                    pass
            
            # Modern Antigravity IDE oauthToken
            cur.execute("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.oauthToken'")
            r = cur.fetchone()
            if r and r[0]:
                try:
                    dec1 = base64.b64decode(r[0])
                    # find all base64 chunks inside dec1
                    b64_chunks = re.findall(r'[A-Za-z0-9+/=]{40,}', dec1.decode('latin1', errors='ignore'))
                    for ch in b64_chunks:
                        try:
                            dec2 = base64.b64decode(ch).decode('latin1', errors='ignore')
                            toks = re.findall(r'ya29\.[A-Za-z0-9_\-]+', dec2)
                            if toks and not access_token:
                                access_token = toks[0]
                            rfs = re.findall(r'1//[A-Za-z0-9_\-]+', dec2)
                            if rfs and not refresh_token:
                                refresh_token = rfs[0]
                        except:
                            pass
                except:
                    pass
            
            # 2. Try legacy antigravityAuthStatus key
            if not email:
                cur.execute("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'")
                r = cur.fetchone()
                if r and r[0]:
                    try:
                        j = json.loads(r[0])
                        email = j.get('email')
                        access_token = j.get('apiKey')
                    except:
                        pass
            
            con.close()
            
            if email:
                return {
                    'email': email,
                    'access_token': access_token,
                    'refresh_token': refresh_token,
                    'source': 'antigravity-ide-db'
                }
        except Exception:
            pass
            
    return None

if __name__ == '__main__':
    auth = extract_auth()
    if auth:
        print(json.dumps(auth))
