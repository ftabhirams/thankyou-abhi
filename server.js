const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// Store room state (Queue, Video, and Host ID)
const rooms = {}; 

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    
    // 1. INITIALIZE ROOM & HOST
    if (!rooms[roomId]) {
      rooms[roomId] = { 
          currentVideo: 'dQw4w9WgXcQ', 
          queue: [],
          host: socket.id // First person in is the Host
      };
    }

    // Tell the user if they are the host
    socket.emit('role-assignment', { isHost: rooms[roomId].host === socket.id });
    
    // Tell others for WebRTC Mesh
    socket.to(roomId).emit('user-connected', socket.id);
    
    // Sync new user with current media state
    socket.emit('queue-updated', rooms[roomId].queue);
    socket.emit('force-video-change', rooms[roomId].currentVideo);

    // =====================================
    // MEDIA & QUEUE SYNC (Patched)
    // =====================================
    
    socket.on('add-to-queue', (videoId) => {
      // SECURITY FIX: Prevent massive payloads and limit queue size
      if (typeof videoId !== 'string' || videoId.length > 200) return;
      if (rooms[roomId].queue.length >= 50) return;

      rooms[roomId].queue.push(videoId);
      io.to(roomId).emit('queue-updated', rooms[roomId].queue);
    });

    socket.on('video-ended', (finishedVideoId) => {
      if (rooms[roomId].currentVideo === finishedVideoId) {
        if (rooms[roomId].queue.length > 0) {
          const nextVideo = rooms[roomId].queue.shift();
          rooms[roomId].currentVideo = nextVideo;
          
          io.to(roomId).emit('force-video-change', nextVideo);
          io.to(roomId).emit('queue-updated', rooms[roomId].queue);
        }
      }
    });

    // SECURITY FIX: Only accept playback commands from the Host
    socket.on('sync-video', (data) => {
      if (rooms[roomId].host === socket.id) {
          socket.to(roomId).emit('update-video', data);
      }
    });

    socket.on('load-movie', (url) => {
      if (typeof url !== 'string' || url.length > 1000) return;
      if (rooms[roomId].host === socket.id) {
          io.to(roomId).emit('load-movie', url);
      }
    });

    socket.on('sync-movie', (data) => {
      if (rooms[roomId].host === socket.id) {
          socket.to(roomId).emit('sync-movie', data);
      }
    });

    // =====================================
    // CHAT & WEBRTC SIGNALING
    // =====================================

    socket.on('send-chat', (message) => {
      // SECURITY FIX: Prevent massive text payloads
      if (typeof message !== 'string' || message.length > 1000) return;
      io.to(roomId).emit('receive-chat', message, socket.id);
    });
    
    socket.on('webrtc-offer', (offer, targetId) => io.to(targetId).emit('webrtc-offer', offer, socket.id));
    socket.on('webrtc-answer', (answer, targetId) => io.to(targetId).emit('webrtc-answer', answer, socket.id));
    socket.on('webrtc-ice-candidate', (candidate, targetId) => io.to(targetId).emit('webrtc-ice-candidate', candidate, socket.id));

    // =====================================
    // DISCONNECT & MEMORY CLEANUP
    // =====================================
    socket.on('disconnect', () => {
      socket.to(roomId).emit('user-disconnected', socket.id);

      const currentRoom = io.sockets.adapter.rooms.get(roomId);
      
      // SECURITY FIX: Delete room data if empty to prevent RAM leaks
      if (!currentRoom || currentRoom.size === 0) {
          delete rooms[roomId]; 
      } 
      // HOST TRANSFER: If host leaves, give crown to next person
      else if (rooms[roomId] && rooms[roomId].host === socket.id) {
          const newHostId = Array.from(currentRoom)[0];
          rooms[roomId].host = newHostId;
          io.to(roomId).emit('new-host', newHostId);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
