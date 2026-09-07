const socket = io('/');
let ROOM_ID = '';
let localStream = null;
let screenStream = null;
const peers = {}; 
const iceQueues = {}; 
let isMyHost = false; 

const servers = { iceServers: [{ urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }] };

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));
}

// ==========================================
// 1. AUTHENTICATION UI
// ==========================================
function switchTab(tab) {
    document.getElementById('tab-join').classList.remove('active');
    document.getElementById('tab-create').classList.remove('active');
    document.getElementById('form-join').classList.remove('active');
    document.getElementById('form-create').classList.remove('active');
    
    document.getElementById('tab-' + tab).classList.add('active');
    document.getElementById('form-' + tab).classList.add('active');
    document.getElementById('auth-err').innerText = "";
}

function createRoom() {
    const pass = document.getElementById('create-room-pass').value;
    socket.emit('create-room', pass);
}

function joinRoom() {
    const code = document.getElementById('join-room-code').value.trim();
    const pass = document.getElementById('join-room-pass').value;
    if (!code) { document.getElementById('auth-err').innerText = "Room code required"; return; }
    socket.emit('join-room', { roomId: code, password: pass });
}

socket.on('auth-error', (msg) => { document.getElementById('auth-err').innerText = msg; });

socket.on('auth-success', (roomId) => {
    ROOM_ID = roomId;
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('main-app').style.display = 'flex';
    document.getElementById('room-display-name').innerText = roomId;
    
    if (!player) initYouTubePlayer();

    // Request Camera AFTER room is visible
    navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
        localStream = stream;
        document.getElementById('my-video').srcObject = stream;
        isCameraReady = true;
        processSignalQueue(); // Fire off any connections that were waiting!
        socket.emit('room-ready', ROOM_ID);
    }).catch(err => {
        console.warn("Camera access denied. User is a viewer.");
        isCameraReady = true; // Still ready to RECEIVE video!
        processSignalQueue();
        socket.emit('room-ready', ROOM_ID); 
    });
});

function toggleCamera() {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    track.enabled = !track.enabled;
    const btn = document.getElementById('cam-btn');
    btn.innerText = track.enabled ? "📷 Cam On" : "🚫 Cam Off";
    btn.classList.toggle('off', !track.enabled);
}

function toggleMic() {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    const btn = document.getElementById('mic-btn');
    btn.innerText = track.enabled ? "🎤 Mic On" : "🔇 Mic Off";
    btn.classList.toggle('off', !track.enabled);
}

function toggleFullScreen() {
    const wrapper = document.getElementById('media-wrapper');
    if (!document.fullscreenElement) wrapper.requestFullscreen().catch(e => console.log("Fullscreen blocked"));
    else document.exitFullscreen();
}

// ==========================================
// 2. DRAGGABLE VIDEOS
// ==========================================
let activeDragEl = null;
let startX, startY, initX, initY;

function startDrag(e) {
    const wrapper = e.target.closest('.video-wrapper');
    if (!wrapper || e.target.closest('button')) return;
    
    if (e.type === 'mousedown') e.preventDefault(); 
    activeDragEl = wrapper;
    startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    startY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    
    const rect = activeDragEl.getBoundingClientRect();
    initX = rect.left; 
    initY = rect.top;
    
    activeDragEl.style.width = rect.width + 'px';
    activeDragEl.style.height = rect.height + 'px';
    activeDragEl.style.position = 'fixed'; 
    activeDragEl.style.margin = '0';
    activeDragEl.style.right = 'auto'; 
    activeDragEl.style.bottom = 'auto';
    activeDragEl.style.left = initX + 'px';
    activeDragEl.style.top = initY + 'px';
    activeDragEl.style.zIndex = 1000;
}

function moveDrag(e) {
    if (!activeDragEl) return;
    if (e.cancelable) e.preventDefault(); 
    
    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    
    activeDragEl.style.left = (initX + (clientX - startX)) + 'px';
    activeDragEl.style.top = (initY + (clientY - startY)) + 'px';
}

function stopDrag() { 
    if(activeDragEl) {
        activeDragEl.style.zIndex = 50;
        activeDragEl = null; 
    }
}

document.addEventListener('mousedown', startDrag, {passive: false});
document.addEventListener('mousemove', moveDrag, {passive: false});
document.addEventListener('mouseup', stopDrag);
document.addEventListener('touchstart', startDrag, {passive: false});
document.addEventListener('touchmove', moveDrag, {passive: false});
document.addEventListener('touchend', stopDrag);


// ==========================================
// 3. HOST CONTROLS
// ==========================================
socket.on('role-assignment', (data) => {
    isMyHost = data.isHost;
    updateHostUI();
});

socket.on('new-host', (newHostId) => {
    isMyHost = (newHostId === socket.id);
    updateHostUI();
});

function updateHostUI() {
    document.getElementById('host-badge').style.display = isMyHost ? 'inline-block' : 'none';
    document.getElementById('direct-video-container').style.display = isMyHost ? 'flex' : 'none';
    const queueBtn = document.getElementById('queue-btn');
    if (queueBtn) queueBtn.innerText = isMyHost ? "Queue YT" : "Recommend";
    
    if (isMyHost) document.body.classList.add('host-mode');
    else document.body.classList.remove('host-mode');
}

// ==========================================
// 4. WEBRTC SIGNALING QUEUE (The Race-Condition Fix)
// ==========================================
let isCameraReady = false;
let signalQueue = [];

function processSignalQueue() {
    signalQueue.forEach(async (task) => await task());
    signalQueue = [];
}

function createPeerConnection(targetUserId) {
    const pc = new RTCPeerConnection(servers);
    peers[targetUserId] = pc;
    iceQueues[targetUserId] = []; 

    if (localStream) {
        const activeStream = screenStream ? screenStream : localStream;
        activeStream.getTracks().forEach(track => pc.addTrack(track, activeStream));
    }

    pc.onicecandidate = (e) => { 
        if (e.candidate) socket.emit('webrtc-ice-candidate', e.candidate, targetUserId); 
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
        const vidEl = document.getElementById(`video-${targetUserId}`);
        vidEl.srcObject = event.streams[0];
        
        // Ensure browser forces playback on new streams
        vidEl.onloadedmetadata = () => { vidEl.play().catch(e => console.log("Autoplay caught:", e)); };
    };
    return pc;
}

socket.on('user-connected', (userId) => {
    const task = async () => {
        const pc = createPeerConnection(userId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', offer, userId);
    };
    if (!isCameraReady) signalQueue.push(task); else task();
});

socket.on('webrtc-offer', (offer, senderId) => {
    const task = async () => {
        const pc = createPeerConnection(senderId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-answer', answer, senderId);
        
        if (iceQueues[senderId]) {
            for (let c of iceQueues[senderId]) await pc.addIceCandidate(new RTCIceCandidate(c));
            iceQueues[senderId] = [];
        }
    };
    if (!isCameraReady) signalQueue.push(task); else task();
});

socket.on('webrtc-answer', (answer, senderId) => {
    const task = async () => {
        const pc = peers[senderId];
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            if (iceQueues[senderId]) {
                for (let c of iceQueues[senderId]) await pc.addIceCandidate(new RTCIceCandidate(c));
                iceQueues[senderId] = [];
            }
        }
    };
    if (!isCameraReady) signalQueue.push(task); else task();
});

socket.on('webrtc-ice-candidate', async (c, senderId) => {
    const pc = peers[senderId];
    if (pc) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(c)).catch(e=>console.log(e));
        } else {
            iceQueues[senderId].push(c); 
        }
    }
});

socket.on('user-disconnected', (userId) => {
    if (peers[userId]) { peers[userId].close(); delete peers[userId]; delete iceQueues[userId]; }
    const wrapper = document.getElementById(`wrapper-${userId}`);
    if (wrapper) wrapper.remove();
});

// Screen Sharing Logic
async function toggleScreenShare() {
    const btn = document.getElementById('screen-share-btn');
    if (screenStream) { stopScreenShare(); return; }
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const screenVideoTrack = screenStream.getVideoTracks()[0];
        document.getElementById('my-video').srcObject = screenStream;
        btn.innerText = "🛑 Stop Sharing"; btn.style.background = "var(--danger)";

        for (let userId in peers) {
            const videoSender = peers[userId].getSenders().find(s => s.track.kind === 'video');
            if (videoSender) videoSender.replaceTrack(screenVideoTrack);
        }
        screenVideoTrack.onended = () => stopScreenShare();
    } catch (err) {}
}

function stopScreenShare() {
    if (!screenStream) return;
    const btn = document.getElementById('screen-share-btn');
    document.getElementById('my-video').srcObject = localStream;
    btn.innerText = "🖥️ Share Screen"; btn.style.background = "var(--secondary)";

    if (localStream) {
        const cameraTrack = localStream.getVideoTracks()[0];
        for (let userId in peers) {
            const videoSender = peers[userId].getSenders().find(s => s.track.kind === 'video');
            if (videoSender) videoSender.replaceTrack(cameraTrack);
        }
    }
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
}


// ==========================================
// 5. YOUTUBE API (The Robust Auto-Recovery Fix)
// ==========================================
let player;
let isYouTubeLoaded = false;
let isPlayerReady = false;
let pendingVideoId = null; 

function onYouTubeIframeAPIReady() {
    isYouTubeLoaded = true;
}

function initYouTubePlayer() {
    if (typeof YT === 'undefined' || typeof YT.Player === 'undefined') {
        setTimeout(initYouTubePlayer, 300); // Wait for external script
        return;
    }
    
    try {
        player = new YT.Player('yt-player', {
            height: '100%',
            width: '100%',
            videoId: 'dQw4w9WgXcQ',
            playerVars: { 'autoplay': 1, 'controls': 1, 'rel': 0, 'enablejsapi': 1 },
            events: { 
                'onReady': onPlayerReady,
                'onStateChange': onPlayerStateChange,
                'onError': (e) => console.error("YouTube Player Error", e.data)
            }
        });
    } catch (err) {
        console.error("YouTube Ghost Load detected, restarting player...", err);
        setTimeout(initYouTubePlayer, 1000);
    }
}

function onPlayerReady(event) {
    isPlayerReady = true;
    if (pendingVideoId) {
        player.loadVideoById(pendingVideoId);
        pendingVideoId = null;
    }
}

function onPlayerStateChange(event) {
    if (isMyHost) {
        socket.emit('sync-video', { roomId: ROOM_ID, state: event.data, time: player.getCurrentTime() });
        if (event.data === YT.PlayerState.ENDED) {
            socket.emit('video-ended', ROOM_ID, player.getVideoData().video_id);
        }
    }
}

// Host Background Sync Heartbeat
setInterval(() => {
    if (isMyHost && isPlayerReady && player && typeof player.getCurrentTime === 'function') {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.PAUSED) {
            socket.emit('sync-video', { roomId: ROOM_ID, state: state, time: player.getCurrentTime() });
        }
    }
}, 2000);

socket.on('update-video', (data) => {
    if (!isPlayerReady || !player || isMyHost || typeof player.seekTo !== 'function') return; 
    
    if (Math.abs(player.getCurrentTime() - data.time) > 2) {
        player.seekTo(data.time);
    }
    
    const currState = player.getPlayerState();
    if (data.state === YT.PlayerState.PLAYING && currState !== YT.PlayerState.PLAYING) player.playVideo();
    else if (data.state === YT.PlayerState.PAUSED && currState !== YT.PlayerState.PAUSED) player.pauseVideo();
});

function addToQueue() {
    const input = document.getElementById('video-id-input');
    let id = input.value.trim();
    if (id.includes('v=')) id = id.split('v=')[1].substring(0, 11);
    else if (id.includes('youtu.be/')) id = id.split('youtu.be/')[1].substring(0, 11);

    if (id) {
        socket.emit('add-to-queue', { roomId: ROOM_ID, videoId: id });
        input.value = ''; 
    }
}

function playFromQueue(index) {
    if (isMyHost) socket.emit('play-from-queue', { roomId: ROOM_ID, index: index });
}

socket.on('queue-updated', (queue) => {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '';
    
    if (queue.length === 0) {
        queueList.innerHTML = '<li style="border:none; background:transparent;">Queue is empty</li>';
    } else {
        queue.forEach((video, index) => {
            queueList.innerHTML += `
                <li>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;">
                        ${index + 1}. ${escapeHTML(video.title)}
                    </span>
                    <button class="play-queue-btn" onclick="playFromQueue(${index})">▶ Play</button>
                </li>`;
        });
    }
});

socket.on('force-video-change', (mediaObj) => {
    const ytContainer = document.getElementById('yt-player-container');
    const html5Container = document.getElementById('html5-player-container');
    const html5Video = document.getElementById('html5-video');

    if (mediaObj.type === 'youtube') {
        ytContainer.style.display = 'block';
        html5Container.style.display = 'none';
        if (!html5Video.paused) html5Video.pause();
        
        if (isPlayerReady && player && typeof player.loadVideoById === 'function') {
            player.loadVideoById(mediaObj.id);
        } else {
            pendingVideoId = mediaObj.id; // Store in memory until API recovers
        }
    } 
    else if (mediaObj.type === 'html5') {
        ytContainer.style.display = 'none';
        html5Container.style.display = 'block';
        if (isPlayerReady && player && typeof player.pauseVideo === 'function') player.pauseVideo();
        html5Video.src = mediaObj.id;
        html5Video.play().catch(e => console.log("Autoplay blocked"));
    }
});

// ==========================================
// 6. HTML5 MOVIE LOGIC
// ==========================================
const html5Video = document.getElementById('html5-video');

function loadDirectMovie() {
    if (!isMyHost) return; 
    const url = document.getElementById('direct-video-input').value.trim();
    if(url) { socket.emit('load-movie', { roomId: ROOM_ID, url: url }); document.getElementById('direct-video-input').value = ''; }
}

setInterval(() => {
    if (isMyHost && html5Video && document.getElementById('html5-player-container').style.display !== 'none') {
        socket.emit('sync-movie', { roomId: ROOM_ID, state: html5Video.paused ? 'pause' : 'play', time: html5Video.currentTime });
    }
}, 2000);

socket.on('sync-movie', (data) => {
    if (isMyHost) return;
    if (Math.abs(html5Video.currentTime - data.time) > 2) html5Video.currentTime = data.time;
    if (data.state === 'play' && html5Video.paused) html5Video.play();
    if (data.state === 'pause' && !html5Video.paused) html5Video.pause();
});

// ==========================================
// 7. CHAT
// ==========================================
function handleChat(e) {
    if (e.key === 'Enter' && e.target.value.trim() !== '') {
        socket.emit('send-chat', { roomId: ROOM_ID, message: e.target.value.trim() });
        e.target.value = '';
    }
}

socket.on('receive-chat', (msg, senderId) => {
    const chatBox = document.getElementById('chat-box');
    const isMe = senderId === socket.id;
    chatBox.innerHTML += `<div class="chat-msg ${isMe ? 'self' : ''}"><b>${isMe ? 'You' : 'Friend'}</b> ${escapeHTML(msg)}</div>`;
    chatBox.scrollTop = chatBox.scrollHeight;
});
