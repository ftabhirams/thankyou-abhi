const socket = io('/');
const ROOM_ID = new URLSearchParams(window.location.search).get('room') || 'default-room';

let localStream;
let screenStream = null;
const peers = {}; 
let isMyHost = false; // Security state tracking

const servers = {
    iceServers: [{ urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }]
};

// ==========================================
// SECURITY PRECAUTIONS (XSS Fix)
// ==========================================
function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])
    );
}

// ==========================================
// 1. INITIALIZE CAMERA & ROOM
// ==========================================
navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
    localStream = stream;
    document.getElementById('my-video').srcObject = stream;
    socket.emit('join-room', ROOM_ID);
}).catch(err => console.error("Camera access denied."));

// ==========================================
// 2. HOST CONTROLS & UI
// ==========================================
socket.on('role-assignment', (data) => {
    isMyHost = data.isHost;
    updateHostUI();
});

socket.on('new-host', (newHostId) => {
    isMyHost = (newHostId === socket.id);
    updateHostUI();
    
    if (isMyHost) {
        const chatBox = document.getElementById('chat-box');
        chatBox.innerHTML += `<div class="chat-msg" style="background: #eab308; color: #000;"><b>System</b> You are now the Room Host 👑</div>`;
        chatBox.scrollTop = chatBox.scrollHeight;
    }
});

function updateHostUI() {
    const badge = document.getElementById('host-badge');
    const directVideoBox = document.getElementById('direct-video-container');
    
    if (isMyHost) {
        badge.style.display = 'inline-block';
        directVideoBox.style.display = 'flex'; 
    } else {
        badge.style.display = 'none';
        directVideoBox.style.display = 'none';
    }
}

// ==========================================
// 3. WEBRTC MESH NETWORK LOGIC
// ==========================================
function createPeerConnection(targetUserId) {
    const pc = new RTCPeerConnection(servers);
    peers[targetUserId] = pc;

    const activeStream = screenStream ? screenStream : localStream;
    activeStream.getTracks().forEach(track => pc.addTrack(track, activeStream));

    pc.onicecandidate = (event) => {
        if (event.candidate) socket.emit('webrtc-ice-candidate', event.candidate, targetUserId);
    };

    pc.ontrack = (event) => {
        let wrapper = document.getElementById(`wrapper-${targetUserId}`);
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.id = `wrapper-${targetUserId}`;
            wrapper.className = 'video-wrapper';
            
            const friendVideo = document.createElement('video');
            friendVideo.id = `video-${targetUserId}`;
            friendVideo.autoplay = true;
            friendVideo.playsInline = true;
            
            wrapper.appendChild(friendVideo);
            document.getElementById('video-grid').appendChild(wrapper);
        }
        document.getElementById(`video-${targetUserId}`).srcObject = event.streams[0];
    };

    return pc;
}

socket.on('user-connected', async (userId) => {
    const pc = createPeerConnection(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', offer, userId);
});

socket.on('webrtc-offer', async (offer, senderId) => {
    const pc = createPeerConnection(senderId);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', answer, senderId);
});

socket.on('webrtc-answer', async (answer, senderId) => {
    if (peers[senderId]) await peers[senderId].setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('webrtc-ice-candidate', async (candidate, senderId) => {
    if (peers[senderId]) await peers[senderId].addIceCandidate(new RTCIceCandidate(candidate));
});

socket.on('user-disconnected', (userId) => {
    if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
    }
    const wrapper = document.getElementById(`wrapper-${userId}`);
    if (wrapper) wrapper.remove();
});

// ==========================================
// 4. SCREEN SHARING LOGIC
// ==========================================
async function toggleScreenShare() {
    const btn = document.getElementById('screen-share-btn');
    if (screenStream) { stopScreenShare(); return; }

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const screenVideoTrack = screenStream.getVideoTracks()[0];
        document.getElementById('my-video').srcObject = screenStream;
        btn.innerText = "🛑 Stop Sharing";
        btn.className = "btn-danger";

        for (let userId in peers) {
            const videoSender = peers[userId].getSenders().find(s => s.track.kind === 'video');
            if (videoSender) videoSender.replaceTrack(screenVideoTrack);
        }
        screenVideoTrack.onended = () => stopScreenShare();
    } catch (err) { console.error("Screen share canceled."); }
}

function stopScreenShare() {
    if (!screenStream) return;
    const btn = document.getElementById('screen-share-btn');
    const cameraVideoTrack = localStream.getVideoTracks()[0];
    
    document.getElementById('my-video').srcObject = localStream;
    btn.innerText = "🖥️ Share Screen";
    btn.className = "btn-secondary";

    for (let userId in peers) {
        const videoSender = peers[userId].getSenders().find(s => s.track.kind === 'video');
        if (videoSender) videoSender.replaceTrack(cameraVideoTrack);
    }
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
}

// ==========================================
// 5. YOUTUBE & QUEUE LOGIC
// ==========================================
let player;
let isHostInitiated = false;
let currentVideoId = 'dQw4w9WgXcQ';

function onYouTubeIframeAPIReady() {
    player = new YT.Player('yt-player', {
        videoId: currentVideoId, 
        events: { 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerStateChange(event) {
    // SECURITY FIX: Only the Host sends playback commands
    if (isHostInitiated && isMyHost) {
        socket.emit('sync-video', { state: event.data, time: player.getCurrentTime() });
        isHostInitiated = false; 
    }
    if (event.data === YT.PlayerState.ENDED) {
        socket.emit('video-ended', currentVideoId);
    }
}

document.getElementById('yt-player-container').addEventListener('click', () => { isHostInitiated = true; });

socket.on('update-video', (data) => {
    if (!player) return;
    if (data.state === YT.PlayerState.PLAYING) {
        player.seekTo(data.time);
        player.playVideo();
    } else if (data.state === YT.PlayerState.PAUSED) {
        player.pauseVideo();
    }
});

function addToQueue() {
    const input = document.getElementById('video-id-input');
    let id = input.value.trim();
    if (id.includes('v=')) id = id.split('v=')[1].substring(0, 11);
    else if (id.includes('youtu.be/')) id = id.split('youtu.be/')[1].substring(0, 11);

    if (id) {
        socket.emit('add-to-queue', id);
        input.value = ''; 
    }
}

socket.on('queue-updated', (queue) => {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '';
    
    if (queue.length === 0) {
        queueList.innerHTML = '<li style="color: var(--text-muted); border-left: none; background: transparent;">Queue is empty</li>';
    } else {
        queue.forEach((vidId, index) => {
            const safeVidId = escapeHTML(vidId); // XSS Protection
            queueList.innerHTML += `<li>${index + 1}. ${safeVidId}</li>`;
        });
    }
});

socket.on('force-video-change', (newVideoId) => {
    currentVideoId = newVideoId;
    document.getElementById('yt-player-container').style.display = 'flex';
    document.getElementById('html5-player-container').style.display = 'none';
    const html5Video = document.getElementById('html5-video');
    if(!html5Video.paused) html5Video.pause();

    if (player && player.loadVideoById) player.loadVideoById(newVideoId);
});

// ==========================================
// 6. DIRECT MOVIE LOGIC (HTML5)
// ==========================================
const html5Video = document.getElementById('html5-video');
let isRemoteAction = false; 

function loadDirectMovie() {
    if (!isMyHost) return; // Only host can load movies
    const input = document.getElementById('direct-video-input');
    const url = input.value.trim();
    if(url) {
        socket.emit('load-movie', url);
        input.value = '';
    }
}

socket.on('load-movie', (url) => {
    document.getElementById('yt-player-container').style.display = 'none';
    document.getElementById('html5-player-container').style.display = 'flex';
    if(player && player.pauseVideo) player.pauseVideo();
    
    html5Video.src = url;
    html5Video.play().catch(e => console.log("Autoplay blocked until user interaction"));
});

// SECURITY FIX: Only host events are broadcasted
html5Video.addEventListener('play', () => {
    if (!isRemoteAction && isMyHost) socket.emit('sync-movie', { state: 'play', time: html5Video.currentTime });
});
html5Video.addEventListener('pause', () => {
    if (!isRemoteAction && isMyHost) socket.emit('sync-movie', { state: 'pause', time: html5Video.currentTime });
});
html5Video.addEventListener('seeked', () => {
    if (!isRemoteAction && isMyHost) socket.emit('sync-movie', { state: 'seek', time: html5Video.currentTime });
});

socket.on('sync-movie', (data) => {
    isRemoteAction = true; 
    if (Math.abs(html5Video.currentTime - data.time) > 1) {
        html5Video.currentTime = data.time;
    }
    if (data.state === 'play') html5Video.play();
    if (data.state === 'pause') html5Video.pause();
    setTimeout(() => { isRemoteAction = false; }, 50);
});

// ==========================================
// 7. CHAT LOGIC
// ==========================================
function handleChat(e) {
    if (e.key === 'Enter' && e.target.value.trim() !== '') {
        socket.emit('send-chat', e.target.value.trim());
        e.target.value = '';
    }
}

socket.on('receive-chat', (msg, senderId) => {
    const safeMsg = escapeHTML(msg); // XSS Protection
    const chatBox = document.getElementById('chat-box');
    
    const isMe = senderId === socket.id;
    const cssClass = isMe ? "chat-msg self" : "chat-msg";
    const senderName = isMe ? "You" : "Friend";

    chatBox.innerHTML += `
        <div class="${cssClass}">
            <b>${senderName}</b> 
            ${safeMsg}
        </div>
    `;
    
    chatBox.scrollTop = chatBox.scrollHeight;
});
