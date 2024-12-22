const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");
const path = require("path");

const app = express();
app.use(express.static("public"));
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

let worker;
let router;
let producers = {}; // { socketId: producer }
let transports = {}; // { socketId: transport[] }

async function setupMediasoup() {
  worker = await mediasoup.createWorker();
  const mediaCodecs = [
    {
      kind: "video",
      mimeType: "video/VP8",
      clockRate: 90000,
      parameters: {},
    },
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
    },
  ];
  router = await worker.createRouter({ mediaCodecs });
}

setupMediasoup();

io.on("connection", (socket) => {
  socket.on("getRouterRtpCapabilities", (_, callback) => {
    callback(router.rtpCapabilities);
  });
  console.log("Client connected:", socket.id);

  // Create WebRTC Transport
  socket.on("createTransport", async (_, callback) => {
    try {
      const transport = await router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      // Save the transport for this socket
      if (!transports[socket.id]) transports[socket.id] = [];
      transports[socket.id].push(transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });

      socket.on("connectTransport", async (dtlsParameters, callback) => {
        try {
          await transport.connect({ dtlsParameters });
          callback();
        } catch (error) {
          console.error("Error connecting transport:", error);
          callback({ error: error.message });
        }
      });
    } catch (error) {
      console.error("Error creating transport:", error);
      callback({ error: error.message });
    }
  });

  // Produce Media
  socket.on("produce", async ({ kind, rtpParameters }, callback) => {
    try {
      const transport = transports[socket.id]?.[0];
      if (!transport) {
        throw new ReferenceError("transport is not definde");
      }

      // if (!kind || typeof kind !== "string") {
      //   throw new TypeError("Missing or invalid parameter: kind");
      // }
      // if (!rtpParameters || typeof rtpParameters !== "object") {
      //   throw new TypeError("Missing or invalid parameter: rtpParameters");
      // }

      const producer = await transport.produce({ kind, rtpParameters });
      if (!producers[socket.id]) {
        producers[socket.id] = [];
      }
      producers[socket.id].push(producer);
      console.log("Producer created:", producer.id);
      callback({ id: producer.id });
    } catch (error) {
      console.error("Error producing:", error);
      callback({ error: error.message });
    }
  });

  // Consume Media
  socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
    try {
      if (!router.canConsume({ producerId, rtpCapabilities })) {
        console.error(
          "Cannot consume. Producer ID or RTP Capabilities mismatch."
        );
        throw new Error("Cannot consume");
      }

      const transport = transports[socket.id]?.[0];
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      console.log("Consumer created:", consumer.id);

      console.log("DTLS Parameters:", transport.dtlsParameters);

      callback({
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        dtlsParameters: transport.dtlsParameters, // 추가
      });
    } catch (error) {
      console.error("Error consuming:", error);
      callback({ error: error.message });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    // Close transports and producers for this socket
    // if (producers[socket.id]) producers[socket.id].close();
    // if (transports[socket.id]) {
    //   transports[socket.id].forEach((transport) => transport.close());
    // }
    if (transports[socket.id]) {
      transports[socket.id].forEach((transport) => transport.close());
    }
    if (producers[socket.id]) {
      producers[socket.id].forEach((producer) => producer.close());
    }
    delete transports[socket.id];
    delete producers[socket.id];
  });
});
app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "index.html");
  res.sendFile(filePath);
});
server.listen(3000, () => {
  console.log("Server listening on port 3000");
});
