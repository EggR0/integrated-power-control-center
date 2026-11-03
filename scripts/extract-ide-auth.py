import sqlite3
import base64
import re
import json
import os

def extract_nested_base64_strings(data):
    results = []
    text = data.decode('latin1', errors='ignore') if isinstance(data, bytes) else data
    chunks = re.findall(r'[A-Za-z0-9+/=]{16,}', text)
    for c in chunks:
        padded = c + '=' * (-len(c) % 4)
        try:
            dec = base64.b64decode(padded)
            results.append(dec)
            dec_text = dec.decode('latin1', errors='ignore')
            sub_chunks = re.findall(r'[A-Za-z0-9+/=]{16,}', dec_text)
            for sc in sub_chunks:
                try:
                    results.append(base64.b64decode(sc + '=' * (-len(sc) % 4)))
                except:
                    pass
        except:
            pass
    return results

def extract_auth():
    db = os.path.expandvars(r'%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb')
    if not os.path.exists(db):
        return None
        
    try:
        con = sqlite3.connect(db)
        cur = con.cursor()
        
        email = None
        access_token = None
        refresh_token = None
        
        cur.execute("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.userStatus'")
        r = cur.fetchone()
        if r and r[0]:
            raw_user = r[0]
            all_blobs = [raw_user.encode('latin1')] + extract_nested_base64_strings(raw_user)
            for b in all_blobs:
                s = b.decode('latin1', errors='ignore')
                emails = re.findall(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+', s)
                if emails:
                    email = emails[0]
                    break
        
        cur.execute("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.oauthToken'")
        r = cur.fetchone()
        if r and r[0]:
            raw_tok = r[0]
            all_blobs = [raw_tok.encode('latin1')] + extract_nested_base64_strings(raw_tok)
            for b in all_blobs:
                s = b.decode('latin1', errors='ignore')
                toks = re.findall(r'ya29\.[A-Za-z0-9_\-]+', s)
                if toks and not access_token:
                    access_token = toks[0]
                rfs = re.findall(r'1//[A-Za-z0-9_\-]+', s)
                if rfs and not refresh_token:
                    refresh_token = rfs[0]
        
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
