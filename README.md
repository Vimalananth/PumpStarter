# pump-controller-bridge

MQTT ↔ Firebase Realtime Database bridge for the pump controller.

## Deploy to Railway

### 1. Push bridge folder to a new GitHub repo

Create a new GitHub repo (e.g. `pump-bridge`) and push only this `bridge/` folder:

```bash
git init
git add .
git commit -m "Initial bridge"
git remote add origin https://github.com/YOUR_USERNAME/pump-bridge.git
git push -u origin main
```

### 2. Create a Railway project

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Select your `pump-bridge` repo
3. Railway auto-detects Node.js and runs `npm start`

### 3. Set environment variables in Railway

Go to your service → **Variables** tab → add these two:

| Variable | Value |
|----------|-------|
| `FIREBASE_SERVICE_ACCOUNT` | Paste the **entire contents** of `serviceAccountKey.json` as a single line |
| `FIREBASE_DB_URL` | `https://pump-controller-4398d-default-rtdb.firebaseio.com` |

To get the single-line JSON for `FIREBASE_SERVICE_ACCOUNT`, run this in the bridge folder:
```bash
node -e "console.log(JSON.stringify(require('./serviceAccountKey.json')))"
```
Copy the output and paste it as the variable value.

### 4. Deploy

Railway deploys automatically on every push to `main`.
