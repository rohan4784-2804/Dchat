# DChat Server

Node.js + Express + Socket.IO backend for the DChat Flutter app. **No MongoDB or other database service is used.** Accounts and messages are saved to a local JSON file named `dchat-data.json`.

## Deploy to Render

1. Open Render and choose **New + → Blueprint**.
2. Connect GitHub and select `rohan4784-2804/Dchat`.
3. Render reads `render.yaml` and configures the service. For manual setup use:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
4. Ensure the `JWT_SECRET` environment variable is set to a random secret of at least 32 characters. The Blueprint generates one automatically.
5. Deploy and visit `https://YOUR-SERVICE-NAME.onrender.com/health`. Expected response includes `"ok":true`.

## Important storage limitation

This version stores data in a local JSON file, not MongoDB. It works without a database account, but **Render's free service filesystem is ephemeral**: accounts and chat history can be lost when Render restarts, redeploys, or replaces the instance. This setup is suitable for testing. Reliable long-term chat history requires a persistent storage option; this code intentionally does not connect to an external database.

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

## Configure Flutter

In `C:\Projects\dchat\lib\main.dart`, set the server base URL to the exact URL Render gives you, for example:

```dart
const String serverUrl = 'https://YOUR-SERVICE-NAME.onrender.com';
```

Do not add `/health` to the base URL. Use the same HTTPS URL for Socket.IO. Do not use `localhost` in the Android app because on a phone, localhost refers to the phone itself.

After changing the URL, rebuild and reinstall the APK.

## Notes

- Render free services may spin down when idle, so the first request after inactivity can be slow.
- Render supports HTTPS and WebSocket connections.
- Never commit your real `.env` file or JWT secrets.
