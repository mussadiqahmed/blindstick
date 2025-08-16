const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://localhost:3000'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server, 
  path: '/ws',
  verifyClient: (info) => {
    // Add authentication logic here if needed
    return true;
  }
});

// Enhanced data structures
let devices = new Map(); // deviceId -> { socket, lastSeen, location, battery, status }
let webClients = new Set();
let locationHistory = []; // Keep last 100 locations
const MAX_HISTORY = 100;

// Device authentication (simple token-based)
const DEVICE_TOKENS = new Set([
  process.env.DEVICE_TOKEN || 'default-device-token-change-me'
]);

function isJSON(str) {
  try { 
    JSON.parse(str); 
    return true; 
  } catch { 
    return false; 
  }
}

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({
    timestamp,
    level,
    message,
    ...data
  }));
}

function broadcastToWeb(data, excludeSocket = null) {
  const message = JSON.stringify(data);
  webClients.forEach(ws => {
    if (ws !== excludeSocket && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
      } catch (error) {
        log('error', 'Failed to send to web client', { error: error.message });
        webClients.delete(ws);
      }
    }
  });
}

function broadcastToDevices(data, excludeSocket = null) {
  const message = typeof data === 'string' ? data : JSON.stringify(data);
  devices.forEach((device, deviceId) => {
    if (device.socket !== excludeSocket && device.socket.readyState === WebSocket.OPEN) {
      try {
        device.socket.send(message);
      } catch (error) {
        log('error', 'Failed to send to device', { deviceId, error: error.message });
        devices.delete(deviceId);
      }
    }
  });
}

function addToHistory(location) {
  locationHistory.push({
    ...location,
    timestamp: Date.now()
  });
  
  if (locationHistory.length > MAX_HISTORY) {
    locationHistory = locationHistory.slice(-MAX_HISTORY);
  }
}

function getLatestLocation() {
  if (locationHistory.length === 0) {
    return { lat: 0, lng: 0, timestamp: 0, accuracy: null };
  }
  return locationHistory[locationHistory.length - 1];
}

function validateLocation(data) {
  return (
    typeof data.lat === 'number' && 
    typeof data.lng === 'number' &&
    data.lat >= -90 && data.lat <= 90 &&
    data.lng >= -180 && data.lng <= 180
  );
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.lastPing = Date.now();
  
  const clientIP = req.socket.remoteAddress;
  log('info', 'New WebSocket connection', { clientIP });

  ws.on('pong', () => { 
    ws.isAlive = true; 
    ws.lastPing = Date.now();
  });

  ws.on('message', (msg) => {
    try {
      const text = msg.toString();

      if (isJSON(text)) {
        const data = JSON.parse(text);

        // Handle device/web identification
        if (data.type === 'hello') {
          const role = data.role || 'web';
          
          if (role === 'device') {
            // Validate device token
            if (!DEVICE_TOKENS.has(data.token)) {
              log('warn', 'Invalid device token', { clientIP });
              ws.close(1008, 'Invalid token');
              return;
            }

            const deviceId = data.deviceId || 'default-device';
            ws.role = 'device';
            ws.deviceId = deviceId;
            
            // Remove old device if exists
            if (devices.has(deviceId)) {
              const oldDevice = devices.get(deviceId);
              if (oldDevice.socket.readyState === WebSocket.OPEN) {
                oldDevice.socket.close();
              }
            }
            
            devices.set(deviceId, {
              socket: ws,
              lastSeen: Date.now(),
              location: getLatestLocation(),
              battery: data.battery || null,
              status: 'connected'
            });
            
            log('info', 'Device connected', { deviceId, clientIP });
            
            // Send current location to all web clients
            const latest = getLatestLocation();
            if (latest.timestamp > 0) {
              broadcastToWeb({
                type: 'location',
                ...latest,
                deviceId
              });
            }
            
            // Send device status to web clients
            broadcastToWeb({
              type: 'device_status',
              deviceId,
              status: 'connected',
              battery: data.battery
            });
            
          } else {
            ws.role = 'web';
            webClients.add(ws);
            log('info', 'Web client connected', { clientIP });
            
            // Send current location and device status
            const latest = getLatestLocation();
            if (latest.timestamp > 0) {
              ws.send(JSON.stringify({
                type: 'location',
                ...latest
              }));
            }
            
            // Send device statuses
            devices.forEach((device, deviceId) => {
              ws.send(JSON.stringify({
                type: 'device_status',
                deviceId,
                status: device.status,
                battery: device.battery,
                lastSeen: device.lastSeen
              }));
            });
          }
          return;
        }

        // Handle location updates from device
        if (data.type === 'location' && ws.role === 'device') {
          if (!validateLocation(data)) {
            log('warn', 'Invalid location data', { deviceId: ws.deviceId, data });
            return;
          }

          const locationData = {
            lat: data.lat,
            lng: data.lng,
            accuracy: data.accuracy || null,
            battery: data.battery || null,
            deviceId: ws.deviceId
          };

          // Update device info
          const device = devices.get(ws.deviceId);
          if (device) {
            device.location = locationData;
            device.lastSeen = Date.now();
            device.battery = data.battery;
          }

          addToHistory(locationData);
          broadcastToWeb({
            type: 'location',
            ...locationData,
            timestamp: Date.now()
          });

          log('info', 'Location updated', { 
            deviceId: ws.deviceId, 
            lat: data.lat, 
            lng: data.lng,
            accuracy: data.accuracy 
          });
          return;
        }

        // Handle find request from web
        if (data.type === 'FIND_ME' && ws.role === 'web') {
          const deviceId = data.deviceId || 'default-device';
          const device = devices.get(deviceId);
          
          if (device && device.socket.readyState === WebSocket.OPEN) {
            device.socket.send('FIND_ME');
            log('info', 'Find request sent to device', { deviceId });
            
            ws.send(JSON.stringify({
              type: 'find_response',
              success: true,
              message: 'Find request sent to device'
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'find_response',
              success: false,
              message: 'Device not connected'
            }));
          }
          return;
        }

      } else {
        // Handle raw text commands (backward compatibility)
        if (text === 'FIND_ME' && ws.role === 'web') {
          broadcastToDevices('FIND_ME', ws);
          log('info', 'Legacy find request broadcast');
        }
      }

    } catch (error) {
      log('error', 'Error processing message', { 
        error: error.message, 
        message: msg.toString().substring(0, 100) 
      });
    }
  });

  ws.on('close', (code, reason) => {
    if (ws.role === 'device' && ws.deviceId) {
      devices.delete(ws.deviceId);
      log('info', 'Device disconnected', { deviceId: ws.deviceId, code, reason });
      
      broadcastToWeb({
        type: 'device_status',
        deviceId: ws.deviceId,
        status: 'disconnected'
      });
    } else if (ws.role === 'web') {
      webClients.delete(ws);
      log('info', 'Web client disconnected', { code, reason });
    }
  });

  ws.on('error', (error) => {
    log('error', 'WebSocket error', { error: error.message });
  });
});

// Enhanced heartbeat with cleanup
setInterval(() => {
  const now = Date.now();
  
  // Check WebSocket connections
  wss.clients.forEach((ws) => {
    if (!ws.isAlive || (now - ws.lastPing) > 60000) {
      log('info', 'Terminating dead connection', { role: ws.role, deviceId: ws.deviceId });
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });

  // Clean up stale devices
  devices.forEach((device, deviceId) => {
    if ((now - device.lastSeen) > 120000) { // 2 minutes
      log('info', 'Removing stale device', { deviceId });
      devices.delete(deviceId);
      
      broadcastToWeb({
        type: 'device_status',
        deviceId,
        status: 'disconnected'
      });
    }
  });
}, 30000);

// Enhanced REST API
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connections: {
      devices: devices.size,
      webClients: webClients.size,
      total: wss.clients.size
    }
  });
});

// WebSocket test endpoint
app.get('/api/ws-test', (req, res) => {
  res.json({
    message: 'WebSocket server is running',
    path: '/ws',
    clients: wss.clients.size,
    devices: devices.size,
    webClients: webClients.size
  });
});

app.get('/api/location', (req, res) => {
  const latest = getLatestLocation();
  res.json({
    ...latest,
    age: latest.timestamp ? Date.now() - latest.timestamp : null
  });
});

app.get('/api/location/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_HISTORY);
  const history = locationHistory.slice(-limit);
  
  res.json({
    locations: history,
    total: history.length,
    oldest: history.length > 0 ? history[0].timestamp : null,
    newest: history.length > 0 ? history[history.length - 1].timestamp : null
  });
});

app.get('/api/devices', (req, res) => {
  const deviceList = Array.from(devices.entries()).map(([deviceId, device]) => ({
    deviceId,
    status: device.status,
    lastSeen: device.lastSeen,
    battery: device.battery,
    location: device.location
  }));
  
  res.json({
    devices: deviceList,
    count: deviceList.length
  });
});

app.post('/api/find/:deviceId?', (req, res) => {
  const deviceId = req.params.deviceId || 'default-device';
  const device = devices.get(deviceId);
  
  if (!device || device.socket.readyState !== WebSocket.OPEN) {
    return res.status(404).json({
      error: 'Device not found or not connected',
      deviceId
    });
  }
  
  try {
    device.socket.send('FIND_ME');
    log('info', 'Find request sent via API', { deviceId });
    
    res.json({
      success: true,
      message: 'Find request sent to device',
      deviceId
    });
  } catch (error) {
    log('error', 'Error sending find request', { deviceId, error: error.message });
    res.status(500).json({
      error: 'Failed to send find request',
      message: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  log('error', 'Express error', { error: error.message, stack: error.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down gracefully');
  
  wss.clients.forEach(ws => {
    ws.close(1001, 'Server shutting down');
  });
  
  server.close(() => {
    log('info', 'Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log('info', 'Server started', { 
    port: PORT, 
    env: process.env.NODE_ENV || 'development' 
  });
});
