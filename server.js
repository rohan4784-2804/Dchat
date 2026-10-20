require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "dchat";
const { MongoClient } = require("mongodb");
const mongoClient = new MongoClient(MONGODB_URI || "mongodb://127.0.0.1:27017");
let db;
let usersCollection;
let messagesCollection;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("Set JWT_SECRET to a random secret of at least 32 characters in Render environment variables.");
  process.exit(1);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: false
}));
app.use(express.json({ limit: "1mb" }));

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const onlineUsers = new Map();
let firebaseMessagingReady = false;

// Set FIREBASE_SERVICE_ACCOUNT_JSON in Render to the JSON contents of a
// Firebase service-account key. Never commit this credential to GitHub.
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseMessagingReady = true;
    console.log("Firebase Cloud Messaging is configured.");
  } catch (error) {
    console.error("Firebase initialization failed. Check FIREBASE_SERVICE_ACCOUNT_JSON:", error.message);
  }
} else {
  console.warn("Firebase push notifications are disabled: FIREBASE_SERVICE_ACCOUNT_JSON is not set.");
}

let users = [];
let messages = [];
let writeQueue = Promise.resolve();

async function loadData() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is missing. Add your MongoDB Atlas connection string in Render Environment settings.");
  }
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB_NAME);
  usersCollection = db.collection("users");
  messagesCollection = db.collection("messages");

  users = await usersCollection.find({}, { projection: { _id: 0 } }).toArray();
  messages = await messagesCollection.find({}, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  console.log(`Connected to MongoDB Atlas database "${MONGODB_DB_NAME}". Loaded ${users.length} users and ${messages.length} messages.`);
}

// Persist cached records to Atlas. The queue prevents overlapping full snapshots.
function persistData() {
  const usersSnapshot = users.map((user) => ({ ...user }));
  const messagesSnapshot = messages.map((message) => ({ ...message }));
  writeQueue = writeQueue.then(async () => {
    await usersCollection.deleteMany({});
    if (usersSnapshot.length) await usersCollection.insertMany(usersSnapshot);
    await messagesCollection.deleteMany({});
    if (messagesSnapshot.length) await messagesCollection.insertMany(messagesSnapshot);
  });
  return writeQueue;
}

function publicUser(user) {
  return { username: user.username, createdAt: user.createdAt };
}

function usersFor(username) {
  const currentUsername = String(username || "").toLowerCase();
  return users
    .filter((user) => user.username.toLowerCase() !== currentUsername)
    .map((user) => ({
      ...publicUser(user),
      online: (onlineUsers.get(user.username) || 0) > 0
    }));
}

// Send each connected chat app its own current user list.
// This lets every client refresh automatically without pressing the button.
function broadcastUserLists() {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit("users:update", {
      ok: true,
      users: usersFor(socket.user?.username)
    });
  }
}

function makeToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "30d" });
}

function findUser(username) {
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Authentication required." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("DChat Server is running. See /health.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "DChat Server", storage: "mongodb-atlas", database: MONGODB_DB_NAME });
});

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 3–24 characters and use letters, numbers, _, . or -." });
    }
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (findUser(username)) return res.status(409).json({ error: "Username already exists." });

    const user = {
      username,
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: new Date().toISOString()
    };
    users.push(user);
    await persistData();
    broadcastUserLists();

    return res.status(201).json({
      ok: true,
      token: makeToken(username),
      user: publicUser(user)
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const user = findUser(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    res.json({ ok: true, token: makeToken(user.username), user: publicUser(user) });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Could not log in." });
  }
});

// Register the signed-in user's Android FCM token for push notifications.
app.post("/api/push-token", requireAuth, async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token || token.length > 4096) {
      return res.status(400).json({ ok: false, error: "A valid FCM token is required." });
    }
    const user = findUser(req.user.username);
    if (!user) return res.status(404).json({ ok: false, error: "Account not found." });
    if (!Array.isArray(user.fcmTokens)) user.fcmTokens = [];
    user.fcmTokens = user.fcmTokens.filter((entry) => entry !== token);
    user.fcmTokens.push(token);
    // Keep only the most recent five devices per account.
    user.fcmTokens = user.fcmTokens.slice(-5);
    await persistData();
    return res.json({ ok: true });
  } catch (error) {
    console.error("Register push token error:", error);
    return res.status(500).json({ ok: false, error: "Could not register push token." });
  }
});

app.delete("/api/push-token", requireAuth, async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const user = findUser(req.user.username);
    if (!user) return res.status(404).json({ ok: false, error: "Account not found." });
    if (Array.isArray(user.fcmTokens)) {
      user.fcmTokens = user.fcmTokens.filter((entry) => entry !== token);
      await persistData();
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error("Remove push token error:", error);
    return res.status(500).json({ ok: false, error: "Could not remove push token." });
  }
});

async function sendPushNotification(recipient, message) {
  if (!firebaseMessagingReady || !Array.isArray(recipient.fcmTokens) || recipient.fcmTokens.length === 0) {
    return;
  }

  // FCM notification payloads are shown by Android when the app is in the
  // background or terminated. Data fields allow the app to open the right chat.
  const tokens = [...new Set(recipient.fcmTokens)].slice(0, 500);
  try {
    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: message.from,
        body: message.text.length > 180 ? message.text.slice(0, 177) + "..." : message.text
      },
      data: {
        type: "chat",
        sender: message.from,
        recipient: message.to,
        messageId: message.id
      },
      android: {
        priority: "high",
        notification: {
          channelId: "dchat_messages",
          sound: "default"
        }
      }
    });

    const invalidTokens = [];
    result.responses.forEach((response, index) => {
      if (!response.success) {
        const code = response.error?.code || "";
        if (code.includes("registration-token-not-registered") ||
            code.includes("invalid-registration-token")) {
          invalidTokens.push(tokens[index]);
        } else {
          console.warn("FCM delivery error:", code || response.error?.message || "unknown error");
        }
      }
    });

    if (invalidTokens.length) {
      recipient.fcmTokens = recipient.fcmTokens.filter((token) => !invalidTokens.includes(token));
      await persistData();
    }
  } catch (error) {
    // A push failure must not prevent the chat message from being saved/delivered.
    console.error("FCM send failed:", error.message);
  }
}

app.get("/api/me", requireAuth, (req, res) => {
  const user = findUser(req.user.username);
  if (!user) return res.status(404).json({ error: "Account not found." });
  res.json({ user: publicUser(user) });
});

app.get("/api/users", requireAuth, (req, res) => {
  // Keep the response contract consistent with the Flutter client.
  res.status(200).json({ ok: true, users: usersFor(req.user?.username) });
});

app.get("/api/messages/:username", requireAuth, (req, res) => {
  const other = String(req.params.username || "").trim();
  if (!findUser(other)) return res.status(404).json({ error: "User not found." });
  const conversation = messages.filter((m) =>
    (m.from === req.user.username && m.to.toLowerCase() === other.toLowerCase()) ||
    (m.to.toLowerCase() === req.user.username.toLowerCase() && m.from.toLowerCase() === other.toLowerCase())
  );
  res.status(200).json({ ok: true, messages: conversation.slice(-2000) });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
});

io.on("connection", (socket) => {
  const username = socket.user.username;
  socket.join(`user:${username}`);
  onlineUsers.set(username, (onlineUsers.get(username) || 0) + 1);
  io.emit("presence:update", { username, online: true });
  broadcastUserLists();

  socket.on("message:send", async (payload, acknowledge) => {
    try {
      // Accept recipient usernames from different client versions, including
      // clients that pass the selected user object instead of a plain string.
      const recipientValue =
        payload?.to ??
        payload?.recipient ??
        payload?.recipientUsername ??
        payload?.receiverUsername ??
        payload?.targetUsername ??
        payload?.receiver;

      const toInput = typeof recipientValue === "string"
        ? recipientValue.trim()
        : String(
            recipientValue?.username ??
            recipientValue?.user?.username ??
            recipientValue?.recipientUsername ??
            recipientValue?.name ??
            ""
          ).trim();

      const recipient = findUser(toInput);
      const body = String(payload?.text ?? payload?.message ?? payload?.body ?? "").trim();

      if (!recipient || recipient.username.toLowerCase() === username.toLowerCase()) {
        console.warn("Rejected message recipient:", {
          from: username,
          requestedRecipient: toInput || "(missing)",
          knownUsers: users.map((user) => user.username)
        });
        if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Choose a valid recipient." });
        return;
      }
      if (!body || body.length > 5000) {
        if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Message must contain 1–5000 characters." });
        return;
      }

      const message = {
        id: randomUUID(),
        from: username,
        to: recipient.username,
        text: body,
        createdAt: new Date().toISOString()
      };
      messages.push(message);
      await persistData();
      await sendPushNotification(recipient, message);

      io.to(`user:${username}`).emit("message:new", message);
      io.to(`user:${recipient.username}`).emit("message:new", message);
      if (typeof acknowledge === "function") acknowledge({ ok: true, message });
    } catch (error) {
      console.error("Send message error:", error);
      if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Message could not be saved or sent." });
    }
  });

  socket.on("disconnect", () => {
    const count = Math.max(0, (onlineUsers.get(username) || 1) - 1);
    if (count === 0) {
      onlineUsers.delete(username);
      io.emit("presence:update", { username, online: false });
    } else {
      onlineUsers.set(username, count);
    }
    broadcastUserLists();
  });
});

process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

loadData()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => console.log(`DChat server listening on port ${PORT}`));
  })
  .catch((error) => {
    console.error("Could not connect to MongoDB Atlas or load data:", error.message);
    process.exit(1);
  });
