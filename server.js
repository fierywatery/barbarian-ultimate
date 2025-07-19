const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

const METADATA_FILE = path.join(__dirname, 'video-metadata.json');
const CACHE_DURATION = {
  VIDEOS: 3600,
  THUMBNAILS: 86400,
  EMOTES: 86400,
  VIDEO_PLAYLIST: 300,
  MP4_CONTENT: 3600
};
const SYNC_INTERVAL = 60 * 60 * 1000; // Sync every hour
let cheersData = {}; // Cache for Twitch bits/cheers data

// Detect if running in Electron app vs web browser
const isElectron = process.env.ELECTRON_APP === 'true' || 
                   process.env.ELECTRON_IS_DEV !== undefined || 
                   process.versions && process.versions.electron;

console.log('Electron detection:', {
  ELECTRON_APP: process.env.ELECTRON_APP,
  ELECTRON_IS_DEV: process.env.ELECTRON_IS_DEV,
  hasElectronVersion: !!(process.versions && process.versions.electron),
  isElectron: isElectron
});

app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

async function loadCheersData() {
  try {
    console.log('Loading cheers data...');
    
    const cheersResponse = await fetch('https://barbarian.men/macaw45/cheers.json');
    
    if (cheersResponse.ok) {
      cheersData = await cheersResponse.json();
      console.log(`Loaded ${Object.keys(cheersData).length} cheer providers`);
    }
  } catch (error) {
    console.error('Failed to load cheers data:', error);
  }
}

async function loadMetadata() {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.log('No existing metadata file, starting fresh');
    return {};
  }
}

async function saveMetadata(metadata) {
  await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

// Calculate total video duration by parsing HLS playlist segments
async function getVideoDuration(videoId) {
  try {
    console.log(`Fetching duration for video ${videoId}...`);
    const m3u8Response = await fetch(`https://barbarian.men/macaw45/videos/v${videoId}.m3u8`);
    
    if (!m3u8Response.ok) {
      console.error(`Failed to fetch M3U8 for ${videoId}: HTTP ${m3u8Response.status}`);
      return null;
    }
    
    const m3u8Content = await m3u8Response.text();
    
    let totalDuration = 0;
    const lines = m3u8Content.split('\n');
    
    // Sum up all segment durations from #EXTINF tags
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        const match = line.match(/#EXTINF:([0-9.]+),/);
        if (match) {
          const duration = parseFloat(match[1]);
          totalDuration += duration;
        }
      }
    }
    
    const roundedDuration = Math.round(totalDuration);
    console.log(`Duration for ${videoId}: ${roundedDuration}s (${Math.floor(roundedDuration/3600)}:${Math.floor((roundedDuration%3600)/60).toString().padStart(2,'0')}:${(roundedDuration%60).toString().padStart(2,'0')})`);
    return roundedDuration;
  } catch (error) {
    console.error(`Failed to get duration for ${videoId}:`, error);
    return null;
  }
}

async function syncMetadata() {
  try {
    console.log('Syncing video metadata...');
    const localMetadata = await loadMetadata();
    
    const response = await fetch('https://barbarian.men/macaw45/videos.json');
    const remoteVideos = await response.json();
    
    // Handle both array and object formats
    const remoteArray = Array.isArray(remoteVideos) ? remoteVideos : Object.values(remoteVideos);
    console.log(`Remote videos: ${remoteArray.length} total videos (format: ${Array.isArray(remoteVideos) ? 'array' : 'object'})`);
    console.log(`Sample remote video:`, remoteArray[0]);
    
    let updated = false;
    let newVideoCount = 0;
    
    // Create a set of existing VOD IDs for fast duplicate detection
    const existingVodIds = new Set(Object.values(localMetadata).map(v => v.vodid));
    
    for (let i = 0; i < remoteArray.length; i++) {
      const videoData = remoteArray[i];
      const vodId = videoData.vodid;
      
      // Check if this VOD ID already exists in our metadata
      if (!existingVodIds.has(vodId)) {
        console.log(`New video found: Index ${i}, VOD ID ${vodId} - ${videoData.title}`);
        
        const duration = await getVideoDuration(vodId);
        
        // Find the next available index key to avoid collisions
        let indexKey = i.toString();
        while (localMetadata[indexKey]) {
          indexKey = (parseInt(indexKey) + 1).toString();
        }
        
        localMetadata[indexKey] = {
          vodid: vodId,
          title: videoData.title,
          description: videoData.description,
          date: videoData.date,
          duration,
          lastUpdated: new Date().toISOString()
        };
        
        existingVodIds.add(vodId);
        updated = true;
        newVideoCount++;
      }
    }
    
    if (updated) {
      await saveMetadata(localMetadata);
      console.log(`Metadata updated: ${newVideoCount} new videos added`);
    } else {
      console.log('No new videos found');
    }
    
    console.log(`Local metadata now has ${Object.keys(localMetadata).length} videos`);
    return localMetadata;
  } catch (error) {
    console.error('Error syncing metadata:', error);
    return await loadMetadata();
  }
}

app.get('/api/videos', async (req, res) => {
  try {
    if (isElectron) {
      // Electron: fetch directly from remote (no local caching/duration calculation)
      console.log('Electron mode: Fetching videos directly from barbarian.men');
      const response = await fetch('https://barbarian.men/macaw45/videos.json');
      const remoteVideos = await response.json();
      
      const videosArray = Object.entries(remoteVideos).map(([id, video]) => ({
        id,
        ...video,
        duration: null
      }));
      
      console.log(`Serving ${videosArray.length} videos directly from remote`);
      res.set('Cache-Control', `public, max-age=${CACHE_DURATION.VIDEOS}`);
      res.json(videosArray);
    } else {
      // Web mode: serve from local metadata cache with calculated durations
      const metadata = await loadMetadata();
      const videosArray = Object.values(metadata);
      
      // Generate ETag based on metadata content and last update times
      const lastUpdated = Math.max(...videosArray.map(v => new Date(v.lastUpdated || 0).getTime()));
      const etag = `"${videosArray.length}-${lastUpdated}"`;
      
      // Check if client has current version
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end(); // Not Modified
      }
      
      console.log(`Serving ${videosArray.length} videos from local metadata`);
      res.set('ETag', etag);
      res.set('Cache-Control', `public, max-age=${CACHE_DURATION.VIDEOS}`);
      res.json(videosArray);
    }
  } catch (error) {
    console.error('Error serving videos:', error);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});

app.get('/api/thumbnail/:size/:videoId', async (req, res) => {
  try {
    const { size, videoId } = req.params;
    const url = `https://barbarian.men/macaw45/tn/${size}/${videoId}.webp`;
    
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(404).send('Thumbnail not found');
    }
    
    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', `public, max-age=${CACHE_DURATION.THUMBNAILS}`);
    
    response.body.pipe(res);
  } catch (error) {
    console.error('Error fetching thumbnail:', error);
    res.status(500).send('Error fetching thumbnail');
  }
});

// Remove 'v' prefix and '.mp4' suffix from video IDs for consistent formatting
function cleanVideoId(videoId) {
  return videoId.replace(/^v/, '').replace(/\.mp4$/, '');
}

app.get('/api/video/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const cleanId = cleanVideoId(videoId);
    const url = `https://barbarian.men/macaw45/videos/v${cleanId}.m3u8`;
    
    console.log(`Loading video playlist: ${cleanId}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`Video fetch failed: HTTP ${response.status} for ${url}`);
      return res.status(404).send('Video not found');
    }
    
    const m3u8Content = await response.text();
    
    // Rewrite M3U8 playlist to proxy through our server
    const modifiedContent = m3u8Content.replace(
      /^(?!https?:\/\/|#)(.+\.ts)$/gm, // .ts segments
      `https://barbarian.men/macaw45/videos/$1`
    ).replace(
      /URI="([^"]+\.mp4)"/g, // MP4 URIs in quotes
      `URI="/api/mp4/$1"`
    ).replace(
      /^(?!https?:\/\/|#)(.+\.mp4)$/gm, // MP4 files
      `/api/mp4/$1`
    );
    
    res.set('Content-Type', 'application/x-mpegURL');
    res.set('Cache-Control', `public, max-age=${CACHE_DURATION.VIDEO_PLAYLIST}`);
    res.set('Access-Control-Allow-Origin', '*');
    
    res.send(modifiedContent);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).send('Error fetching video');
  }
});

app.get('/api/mp4/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const url = `https://barbarian.men/macaw45/videos/${filename}`;
    
    // Log only the initial request to avoid spam from range requests
    const isFirstRequest = !req.headers.range || req.headers.range === 'bytes=0-';
    if (isFirstRequest) {
      console.log(`Starting MP4 stream: ${filename}`);
    }
    
    // Forward range headers for video seeking support
    const headers = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      console.error(`MP4 fetch failed: HTTP ${response.status} for ${filename}`);
      return res.status(404).send('MP4 not found');
    }
    
    // Forward range response headers for proper video seeking
    if (response.headers.get('content-range')) {
      res.set('Content-Range', response.headers.get('content-range'));
    }
    if (response.headers.get('accept-ranges')) {
      res.set('Accept-Ranges', response.headers.get('accept-ranges'));
    }
    
    res.set('Content-Type', 'video/mp4');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', `public, max-age=${CACHE_DURATION.MP4_CONTENT}`);
    
    res.status(response.status);
    
    response.body.pipe(res);
  } catch (error) {
    console.error('Error fetching MP4:', error);
    res.status(500).send('Error fetching MP4');
  }
});

app.get('/api/emotes/:type', async (req, res) => {
  try {
    const { type } = req.params;
    
    let data;
    switch (type) {
      case 'first-party':
        const firstPartyResponse = await fetch('https://barbarian.men/macaw45/first_party_emotes.json');
        if (!firstPartyResponse.ok) {
          return res.status(404).json({ error: 'First-party emotes not found' });
        }
        data = await firstPartyResponse.json();
        break;
        
      case 'third-party':
        const thirdPartyResponse = await fetch('https://barbarian.men/macaw45/third_party_emotes.json');
        if (!thirdPartyResponse.ok) {
          return res.status(404).json({ error: 'Third-party emotes not found' });
        }
        data = await thirdPartyResponse.json();
        break;
        
      case 'cheers':
        data = cheersData || {};
        break;
        
      default:
        return res.status(404).json({ error: 'Invalid emote type' });
    }
    
    res.set('Cache-Control', `public, max-age=${CACHE_DURATION.EMOTES}`);
    res.json(data);
  } catch (error) {
    console.error(`Error fetching ${req.params.type} emotes:`, error);
    res.status(500).json({ error: `Failed to fetch ${req.params.type} emotes` });
  }
});

app.get('/api/chat/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    const timecodesUrl = `https://barbarian.men/macaw45/comments/${videoId}.json`;
    const timecodesResponse = await fetch(timecodesUrl);

    if (!timecodesResponse.ok) {
      return res.json([]);
    }
    
    const timecodes = await timecodesResponse.json();
    res.json(timecodes);
  } catch (error) {
    console.error('Error fetching chat timecodes:', error);
    res.json([]);
  }
});

// Fetch chat messages for a range of timestamps and merge them chronologically
async function fetchChatMessages(videoId, timeRange) {
  const promises = timeRange.map(async (t) => {
    try {
      const chatUrl = `https://barbarian.men/macaw45/comments/${videoId}/${t}.json`;
      const response = await fetch(chatUrl);
      
      if (response.ok) {
        const messages = await response.json();
        return messages.map(msg => ({ ...msg, video_timestamp: t }));
      }
      return [];
    } catch (err) {
      return [];
    }
  });
  
  const results = await Promise.allSettled(promises);
  return results
    .filter(result => result.status === 'fulfilled')
    .flatMap(result => result.value)
    .sort((a, b) => {
      // Sort by video timestamp first, then by message timestamp
      if (a.video_timestamp !== b.video_timestamp) {
        return a.video_timestamp - b.video_timestamp;
      }
      return (a.timestamp || 0) - (b.timestamp || 0);
    });
}

app.get('/api/chat/:videoId/:startTime/:endTime', async (req, res) => {
  try {
    const { videoId, startTime, endTime } = req.params;
    const start = parseInt(startTime);
    const end = parseInt(endTime);
    
    const timeRange = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    const allMessages = await fetchChatMessages(videoId, timeRange);
    
    res.json(allMessages);
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.json([]);
  }
});

app.get('/api/emote/:path(*)', async (req, res) => {
  try {
    const emotePath = req.params.path;
    const emoteUrl = `https://barbarian.men/macaw45/emotes/${emotePath}`;
    
    const response = await fetch(emoteUrl);
    if (!response.ok) {
      return res.status(404).send('Emote not found');
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.set('Content-Type', contentType);
    }
    
    res.set('Cache-Control', `public, max-age=${CACHE_DURATION.EMOTES}`);
    response.body.pipe(res);
  } catch (error) {
    console.error('Error proxying emote:', error);
    res.status(500).send('Error fetching emote');
  }
});


app.get('/api/sync', async (req, res) => {
  try {
    console.log('Manual sync triggered');
    await syncMetadata();
    await loadCheersData();
    res.json({ message: 'Sync completed - updated metadata and cheers data' });
  } catch (error) {
    console.error('Manual sync failed:', error);
    res.status(500).json({ error: 'Sync failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

async function startup() {
  console.log('Starting VOD Archive server...');
  
  if (isElectron) {
    // Electron: skip local caching, fetch directly from remote
    console.log('Electron mode: Skipping metadata sync, will fetch directly from remote');
    await loadCheersData();
  } else {
    // Web mode: maintain local cache with video durations
    console.log('Web mode: Syncing local metadata with durations');
    await syncMetadata();
    await loadCheersData();
    
    // Schedule automatic syncing every hour
    setInterval(async () => {
      await syncMetadata();
      await loadCheersData();
    }, SYNC_INTERVAL);
    console.log('Scheduled hourly metadata and cheers sync');
  }
  
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startup().catch(console.error);