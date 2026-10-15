# DChat Server

Node.js + Express + Socket.IO backend for the DChat Flutter app.

## Deploy to Render

1. Open Render and choose **New + → Blueprint**; connect the GitHub repository `rohan4784-2804/Dchat`.
2. Render reads `render.yaml`. Or create a Web Service manually with:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
3. In Render's Environment settings, set `MONGODB_URI` to your MongoDB Atlas connection string and `MONGODB_DB` to `dchat`. The blueprint generates `JWT_SECRET`; if you create the service manually, add a random `JWT_SECRET` of at least 32 characters.
4. Deploy. Visit `https://YOUR-SERVICE-NAME.onrender.com/health`. Expected response: `{"ok":true,"service":"DChat Server"}`.

## Persistent storage (important)

Create a MongoDB Atlas database and add its connection string as Render's `MONGODB_URI`. In Atlas, create a database user and allow network access for Render. Atlas's IP access list may require `0.0.0.0/0` for a Render free service; use a strong database password. Never put the URI or password in this repository.

If `MONGODB_URI` is missing, the server uses temporary in-memory storage for testing. Users and messages will be lost when the service restarts, so configure MongoDB for real chat history.

## API and real-time events

- `GET /health` — health check
- `POST /api/register` — JSON `{"username":"alice","password":"a-long-password"}`
- `POST /api/login` — same JSON fields; returns a JWT token
- `GET /api/users` — authenticated user list
- `GET /api/messages/:username` — authenticated conversation history
- Socket.IO connection — send JWT as `auth: { token: "..." }`
- Socket.IO `message:send` — payload `{"to":"bob","text":"Hi"}`
- Socket.IO `message:new` — message fields `id`, `from`, `to`, `text`, `createdAt`

Authenticated HTTP requests use `Authorization: Bearer YOUR_TOKEN`.

## Configure the Flutter app

In `C:\Projects\dchat\lib\main.dart`, set the server base URL to the exact Render URL, for example:

```dart
const String serverUrl = 'https://YOUR-SERVICE-NAME.onrender.com';
```

Do not include `/health` at the end. Use HTTPS. Build and install a new APK after changing the URL.

For Socket.IO, use the same base URL and send the JWT in the handshake auth map. Do not use `localhost` in the Android app: on a phone, localhost refers to the phone itself.

## Notes

- Render free web services may spin down when idle, so the first request after inactivity can be slow.
- Render supports HTTPS and WebSocket connections.
- Never commit `.env`, database passwords, or JWT secrets.
