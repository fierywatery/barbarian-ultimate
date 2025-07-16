const VIDEO_POSITION_CONFIG = {
    saveInterval: 10,
    minSaveTime: 30,
    expireDays: 30,
    resumeThreshold: 60
};

function cleanupOldPositions() {
    const now = Date.now();
    const expireTime = VIDEO_POSITION_CONFIG.expireDays * 24 * 60 * 60 * 1000;
    
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('video_position_')) {
            try {
                const data = JSON.parse(localStorage.getItem(key));
                if (data.timestamp && (now - data.timestamp > expireTime)) {
                    localStorage.removeItem(key);
                }
            } catch (e) {
                localStorage.removeItem(key);
            }
        }
    });
}

function saveVideoPosition(videoId, currentTime, duration) {
    if (currentTime < VIDEO_POSITION_CONFIG.minSaveTime) {
        const existingPosition = getSavedVideoPosition(videoId);
        if (existingPosition) {
            clearVideoPosition(videoId);
        }
        return;
    }
    if (currentTime > duration - 30) return;
    
    if (currentTime > duration - 60) {
        const existingPosition = getSavedVideoPosition(videoId);
        if (existingPosition) {
            clearVideoPosition(videoId);
        }
        return;
    }
    
    const positionData = {
        time: currentTime,
        duration: duration,
        timestamp: Date.now()
    };
    
    localStorage.setItem(`video_position_${videoId}`, JSON.stringify(positionData));
}

function getSavedVideoPosition(videoId) {
    try {
        const data = localStorage.getItem(`video_position_${videoId}`);
        return data ? JSON.parse(data) : null;
    } catch (e) {
        return null;
    }
}

function clearVideoPosition(videoId) {
    localStorage.removeItem(`video_position_${videoId}`);
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function autoResumeVideo(player, savedTime) {
    const onFirstPlay = () => {
        player.off('play', onFirstPlay);
        player.pause();
        
        const onSeeked = () => {
            player.isResuming = false;
            player.off('seeked', onSeeked);
            player.play();
        };
        
        player.isResuming = true;
        player.on('seeked', onSeeked);
        player.currentTime(savedTime);
    };
    
    player.isResuming = true;
    player.on('play', onFirstPlay);
}



class VODArchive {
    
    constructor() {
        this.videos = [];
        this.filteredVideos = [];
        this.currentPage = 1;
        this.itemsPerPage = 25;
        this.currentVideo = null;
        this.player = null;
        this.saveTimer = null;
        this.resumeState = 'none';
        this.maxCachedItems = 200;
        this.itemAccessTimes = new Map();
        
        this.chatOpen = this.loadChatSetting('chatOpen', false);
        this.chatSidebarMode = this.loadChatSetting('chatSidebarMode', false);
        this.chatSize = this.loadChatSetting('chatSize', '30');
        this.hasAppliedChatDefault = false;
        this.chatTimecodes = new Set();
        this.loadedMessageIds = new Set();
        
        this.emoteCache = { firstParty: {}, thirdParty: {}, cheers: {} };
        this.imageCache = new Map();
        
        this.konamiSequence = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyA'];
        this.konamiProgress = [];
        
        this.init();
        cleanupOldPositions();
    }

    async init() {
        await this.loadVideos();
        await this.loadEmoteMappings();
        this.setupEventListeners();
        this.filterAndPaginate();
        this.initializeChatState();
        this.checkURLForVideo();
    }

    initializeChatState() {
        const chatSidebar = document.getElementById('chatSidebar');
        if (chatSidebar) {
            chatSidebar.style.display = 'none';
        }
    }


    async loadEmoteMappings() {
        try {
            const [firstPartyResponse, thirdPartyResponse, cheersResponse] = await Promise.all([
                fetch('/api/emotes/first-party'),
                fetch('/api/emotes/third-party'),
                fetch('/api/emotes/cheers')
            ]);
            
            if (firstPartyResponse.ok) {
                this.emoteCache.firstParty = await firstPartyResponse.json();
            }
            if (thirdPartyResponse.ok) {
                this.emoteCache.thirdParty = await thirdPartyResponse.json();
            }
            if (cheersResponse.ok) {
                this.emoteCache.cheers = await cheersResponse.json();
            }
            
            console.log(`Loaded ${Object.keys(this.emoteCache.firstParty).length} first-party, ${Object.keys(this.emoteCache.thirdParty).length} third-party emotes, and ${Object.keys(this.emoteCache.cheers).length} cheer providers`);
        } catch (error) {
            console.error('Failed to load emote mappings:', error);
        }
    }

    async loadVideos() {
        try {
            const response = await fetch('/api/videos');
            const data = await response.json();
            
            this.videos = data.map(video => ({
                id: video.vodid,
                title: video.title,
                description: video.description,
                date: new Date(video.date),
                duration: video.duration
            }));
            
            this.sortVideos();
            
            document.getElementById('loadingState').style.display = 'none';
            document.getElementById('videoGrid').style.display = 'block';
            document.getElementById('bottomPagination').style.display = 'block';
        } catch (error) {
            console.error('Failed to load videos:', error);
            document.getElementById('loadingState').textContent = 'Failed to load videos. Please try again later.';
        }
    }

    // ============================================================================
    // UI MANAGEMENT (EVENT LISTENERS, PAGINATION, FILTERING)
    // ============================================================================

    setupEventListeners() {
        document.getElementById('titleFilter').addEventListener('input', () => {
            this.currentPage = 1;
            this.filterAndPaginate();
        });

        ['fromDate', 'toDate'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => {
                this.currentPage = 1;
                this.filterAndPaginate();
            });
        });

        this.sortOldestFirst = false; // Track current sort state
        document.getElementById('sortToggle').addEventListener('click', () => {
            this.sortOldestFirst = !this.sortOldestFirst;
            const button = document.getElementById('sortToggle');
            if (this.sortOldestFirst) {
                button.textContent = '↑ Oldest First';
                button.title = 'Currently showing oldest first. Click to show newest first.';
            } else {
                button.textContent = '↓ Newest First';
                button.title = 'Currently showing newest first. Click to show oldest first.';
            }
            this.currentPage = 1;
            this.filterAndPaginate();
        });

        let fromDateWasEmpty = true;
        
        document.getElementById('fromDate').addEventListener('focus', () => {
            fromDateWasEmpty = !document.getElementById('fromDate').value;
        });

        document.getElementById('fromDate').addEventListener('change', () => {
            const fromDate = document.getElementById('fromDate').value;
            const toDate = document.getElementById('toDate').value;
            
            if (fromDate && fromDate.length === 10 && fromDate.match(/^\d{4}-\d{2}-\d{2}$/) && !toDate && fromDateWasEmpty) {
                setTimeout(() => {
                    const toDateInput = document.getElementById('toDate');
                    toDateInput.focus();
                    
                    fromDateWasEmpty = false;
                }, 100);
            } else {
                fromDateWasEmpty = false;
            }
        });

        document.getElementById('clearFilters').addEventListener('click', () => {
            document.getElementById('titleFilter').value = '';
            ['fromDate', 'toDate'].forEach(id => {
                document.getElementById(id).value = '';
            });
            this.sortOldestFirst = false;
            const button = document.getElementById('sortToggle');
            button.textContent = '↓ Newest First';
            button.title = 'Currently showing newest first. Click to show oldest first.';
            this.currentPage = 1;
            this.filterAndPaginate();
        });

        this.setupPaginationControls();
        
        document.getElementById('chatClose').addEventListener('click', () => {
            this.closeChat();
        });

        window.addEventListener('resize', () => {
            this.updatePagination();
            setTimeout(() => this.syncChatSidebarHeight(), 100);
        });

        document.addEventListener('keydown', (e) => {
            this.handleKonamiCode(e.code);
        });
    }

    scrollToTop() {
        document.querySelector('.filters-section').scrollIntoView({ 
            behavior: 'smooth',
            block: 'start'
        });
    }

    setupPaginationControls() {
        const paginationControls = [
            { prev: 'prevBtn', next: 'nextBtn', page: 'pageInput', items: 'itemsPerPage', scrollToTop: false },
            { prev: 'bottomPrevBtn', next: 'bottomNextBtn', page: 'bottomPageInput', items: 'bottomItemsPerPage', scrollToTop: true }
        ];

        paginationControls.forEach(controls => {
            document.getElementById(controls.prev).addEventListener('click', () => {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.filterAndPaginate();
                    if (controls.scrollToTop) this.scrollToTop();
                }
            });

            document.getElementById(controls.next).addEventListener('click', () => {
                const totalPages = Math.ceil(this.filteredVideos.length / this.itemsPerPage);
                if (this.currentPage < totalPages) {
                    this.currentPage++;
                    this.filterAndPaginate();
                    if (controls.scrollToTop) this.scrollToTop();
                }
            });

            document.getElementById(controls.page).addEventListener('change', (e) => {
                const totalPages = Math.ceil(this.filteredVideos.length / this.itemsPerPage);
                const page = Math.max(1, Math.min(totalPages, parseInt(e.target.value) || 1));
                this.currentPage = page;
                this.filterAndPaginate();
                if (controls.scrollToTop) this.scrollToTop();
            });

            document.getElementById(controls.items).addEventListener('change', (e) => {
                this.itemsPerPage = parseInt(e.target.value);
                document.getElementById('itemsPerPage').value = e.target.value;
                document.getElementById('bottomItemsPerPage').value = e.target.value;
                this.currentPage = 1;
                this.filterAndPaginate();
                if (controls.scrollToTop) this.scrollToTop();
            });
        });
    }

    filterVideos() {
        const titleFilter = document.getElementById('titleFilter').value.toLowerCase();
        const fromDateValue = document.getElementById('fromDate').value;
        const toDateValue = document.getElementById('toDate').value;

        let fromDate = null;
        let toDate = null;

        if (fromDateValue) {
            fromDate = new Date(fromDateValue);
        }

        if (toDateValue) {
            toDate = new Date(toDateValue);
            toDate.setHours(23, 59, 59, 999);
        }

        this.filteredVideos = this.videos.filter(video => {
            if (titleFilter && !video.title.toLowerCase().includes(titleFilter)) {
                return false;
            }

            if (fromDate && video.date < fromDate) {
                return false;
            }
            if (toDate && video.date > toDate) {
                return false;
            }

            return true;
        });
    }

    sortVideos() {
        if (this.sortOldestFirst) {
            this.filteredVideos.sort((a, b) => a.date - b.date); // Oldest first
        } else {
            this.filteredVideos.sort((a, b) => b.date - a.date); // Newest first (default)
        }
    }

    filterAndPaginate() {
        this.filterVideos();
        
        if (this.sortOldestFirst) {
            this.filteredVideos.sort((a, b) => a.date - b.date); // Oldest first
        } else {
            this.filteredVideos.sort((a, b) => b.date - a.date); // Newest first (default)
        }
        
        this.updatePagination();
        this.renderVideos();
    }

    updatePagination() {
        const totalPages = Math.ceil(this.filteredVideos.length / this.itemsPerPage);
        
        const isPhone = window.innerWidth <= 480;
        const videoCountText = isPhone ? '' : ` (${this.filteredVideos.length} videos)`;
        
        document.getElementById('pageInput').value = this.currentPage;
        document.getElementById('pageInput').max = totalPages;
        document.getElementById('pageInfo').textContent = `of ${totalPages}${videoCountText}`;
        document.getElementById('prevBtn').disabled = this.currentPage <= 1;
        document.getElementById('nextBtn').disabled = this.currentPage >= totalPages;
        
        document.getElementById('bottomPageInput').value = this.currentPage;
        document.getElementById('bottomPageInput').max = totalPages;
        document.getElementById('bottomPageInfo').textContent = `of ${totalPages}${videoCountText}`;
        document.getElementById('bottomPrevBtn').disabled = this.currentPage <= 1;
        document.getElementById('bottomNextBtn').disabled = this.currentPage >= totalPages;
    }

    renderVideos() {
        const grid = document.getElementById('videoGrid');
        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = startIndex + this.itemsPerPage;
        const videosToShow = this.filteredVideos.slice(startIndex, endIndex);

        const existingItems = grid.querySelectorAll('.video-item');
        const shouldRebuild = existingItems.length === 0;

        if (shouldRebuild) {
            this.buildVideoGrid(grid, videosToShow);
        } else {
            const firstExistingVideoId = existingItems[0]?.dataset.videoId;
            const firstNewVideoId = videosToShow[0]?.id;
            
            if (firstExistingVideoId !== firstNewVideoId) {
                this.buildVideoGrid(grid, videosToShow);
            } else {
                this.updateVideoGrid(grid, videosToShow);
            }
        }
    }

    buildVideoGrid(grid, videosToShow) {
        grid.innerHTML = videosToShow.map(video => {
            const savedPosition = getSavedVideoPosition(video.id);
            const hasResume = savedPosition && savedPosition.time > VIDEO_POSITION_CONFIG.resumeThreshold;
            
            return `
                <div class="video-item" data-video-id="${video.id}" onclick="archive.loadVideo('${video.id}')">
                    <div class="video-thumbnail-container">
                        <img class="video-thumbnail" 
                             src="/api/thumbnail/72/${video.id}" 
                             alt="${video.title}"
                             loading="lazy"
                             onerror="this.style.background='#333'; this.style.color='#666'; this.style.display='flex'; this.style.alignItems='center'; this.style.justifyContent='center'; this.innerHTML='No Image';">
                        ${hasResume ? `<div class="resume-overlay">⏸ ${formatTime(savedPosition.time)}</div>` : ''}
                    </div>
                    <div class="video-info">
                        <div class="video-item-title">${video.title}</div>
                        <div class="video-item-date">
                            ${video.date.toLocaleDateString('en-US', { 
                                year: 'numeric', 
                                month: 'long', 
                                day: 'numeric' 
                            })}${video.duration ? ` • ${formatTime(video.duration)}` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    updateVideoGrid(grid, videosToShow) {
        const existingItems = Array.from(grid.querySelectorAll('.video-item'));
        const now = Date.now();
        
        videosToShow.forEach(video => {
            this.itemAccessTimes.set(video.id, now);
        });
        
        if (existingItems.length > this.maxCachedItems) {
            const itemsWithTimes = existingItems.map(item => ({
                element: item,
                videoId: item.dataset.videoId,
                lastAccess: this.itemAccessTimes.get(item.dataset.videoId) || 0
            })).sort((a, b) => a.lastAccess - b.lastAccess);
            
            const itemsToRemove = itemsWithTimes.slice(0, existingItems.length - this.maxCachedItems);
            itemsToRemove.forEach(({ element, videoId }) => {
                element.remove();
                this.itemAccessTimes.delete(videoId);
            });
        }
        
        const remainingItems = Array.from(grid.querySelectorAll('.video-item'));
        
        remainingItems.forEach(item => item.style.display = 'none');
        
        videosToShow.forEach((video, index) => {
            let item = remainingItems.find(el => el.dataset.videoId === video.id);
            
            if (!item) {
                const savedPosition = getSavedVideoPosition(video.id);
                const hasResume = savedPosition && savedPosition.time > VIDEO_POSITION_CONFIG.resumeThreshold;
                
                item = document.createElement('div');
                item.className = 'video-item';
                item.dataset.videoId = video.id;
                item.onclick = () => archive.loadVideo(video.id);
                item.innerHTML = `
                    <div class="video-thumbnail-container">
                        <img class="video-thumbnail" 
                             src="/api/thumbnail/72/${video.id}" 
                             alt="${video.title}"
                             loading="lazy"
                             onerror="this.style.background='#333'; this.style.color='#666'; this.style.display='flex'; this.style.alignItems='center'; this.style.justifyContent='center'; this.innerHTML='No Image';">
                        ${hasResume ? `<div class="resume-overlay">⏸ ${formatTime(savedPosition.time)}</div>` : ''}
                    </div>
                    <div class="video-info">
                        <div class="video-item-title">${video.title}</div>
                        <div class="video-item-date">
                            ${video.date.toLocaleDateString('en-US', { 
                                year: 'numeric', 
                                month: 'long', 
                                day: 'numeric' 
                            })}${video.duration ? ` • ${formatTime(video.duration)}` : ''}
                        </div>
                    </div>
                `;
                grid.appendChild(item);
                this.itemAccessTimes.set(video.id, now);
            } else {
                const savedPosition = getSavedVideoPosition(video.id);
                const hasResume = savedPosition && savedPosition.time > VIDEO_POSITION_CONFIG.resumeThreshold;
                const container = item.querySelector('.video-thumbnail-container');
                let overlay = container.querySelector('.resume-overlay');
                
                if (hasResume && !overlay) {
                    overlay = document.createElement('div');
                    overlay.className = 'resume-overlay';
                    overlay.textContent = `⏸ ${formatTime(savedPosition.time)}`;
                    container.appendChild(overlay);
                } else if (hasResume && overlay) {
                    overlay.textContent = `⏸ ${formatTime(savedPosition.time)}`;
                } else if (!hasResume && overlay) {
                    overlay.remove();
                }
                
                this.itemAccessTimes.set(video.id, now);
            }
            
            item.style.display = 'flex';
        });
    }

    // ============================================================================
    // VIDEO LOADING & PLAYER MANAGEMENT
    // ============================================================================

    async loadVideo(videoId) {
        const video = this.videos.find(v => v.id === videoId);
        if (!video) return;

        this.initializeVideoState(video);
        this.updateVideoInfo(video, videoId);
        this.cleanupExistingPlayer();
        
        this.createVideoPlayer(videoId);
        this.setupVideoFeatures(videoId);
        this.finalizeVideoLoad(videoId);
    }


    initializeVideoState(video) {
        this.currentVideo = video;
        this.resumeState = 'none';
        
        this.hasResumed = false;
        this.shouldResume = false;

        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
    }

    updateVideoInfo(video, videoId) {
        history.pushState({ videoId }, video.title, `/${videoId}`);
        document.title = `Macaw45 VOD Archive: ${video.title}`;

        document.getElementById('videoTitle').textContent = video.title;
        document.getElementById('videoSource').innerHTML = `Originally from <a href="https://twitch.tv/videos/${videoId}" target="_blank">https://twitch.tv/videos/${videoId}</a>`;
        document.getElementById('videoDate').textContent = video.date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
        document.getElementById('videoDesc').textContent = video.description || '(no description)';
        document.getElementById('infoSection').style.display = 'block';
    }

    cleanupExistingPlayer() {
        if (this.player) {
            this.player.dispose();
            this.player = null;
        }

        const existingPlayer = videojs.getPlayer('videoPlayer');
        if (existingPlayer) {
            existingPlayer.dispose();
        }

        const placeholder = document.getElementById('videoPlaceholder');
        const playerElement = document.getElementById('videoPlayer');
        
        if (placeholder) placeholder.style.display = 'none';
        if (playerElement) playerElement.remove();
    }

    createVideoPlayer(videoId) {
        const videoContainer = document.getElementById('videoContainer');
        
        const newVideoElement = document.createElement('video');
        newVideoElement.id = 'videoPlayer';
        newVideoElement.className = 'video-js vjs-default-skin';
        newVideoElement.setAttribute('controls', '');
        newVideoElement.setAttribute('preload', 'auto');
        newVideoElement.setAttribute('data-setup', '{}');
        newVideoElement.setAttribute('poster', `/api/thumbnail/720/${videoId}`);
        newVideoElement.setAttribute('tabindex', '0');
        newVideoElement.setAttribute('aria-label', 'Video Player');
        newVideoElement.setAttribute('playsinline', '');

        videoContainer.appendChild(newVideoElement);

        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'video-loading-indicator';
        loadingIndicator.innerHTML = '<div class="video-loading-spinner"></div>';
        videoContainer.appendChild(loadingIndicator);
        
        this.player = videojs('videoPlayer', {
            preload: 'metadata', // Faster initial load
            fluid: true,
            responsive: true,
            aspectRatio: '16:9',
            spatialNavigation: {
                enabled: true,
                horizontalSeek: true
            },
            html5: {
                hls: {
                    enableLowInitialPlaylist: true,
                    limitRenditionByPlayerDimensions: true,
                    useDevicePixelRatio: false,
                    useBandwidthFromLocalStorage: true,
                    maxPlaylistRetries: 2
                }
            }
        });
    }

    setupVideoFeatures(videoId) {
        this.setupSeekDebouncing(this.player);
        this.setupVideoPositionTracking(videoId);
        this.setupVideoTimeTracking(this.player, videoId);
        this.setupFullscreenChat();
        
        this.player.ready(() => {
            this.player.src({
                src: `/api/video/${videoId}`,
                type: 'application/x-mpegURL'
            });
            
            setTimeout(() => this.syncChatSidebarHeight(), 200);
        });
    }


    finalizeVideoLoad(videoId) {
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }

        this.loadedMessageIds.clear();

        this.loadChatTimecodes(videoId);
        this.applyChatDefault();

        const titleElement = document.getElementById('videoTitle');
        this.createChatToggleButton(titleElement);
        this.createChatModeButton(titleElement);
        this.createChatSizeDropdown(titleElement);

        document.querySelector('.video-section').scrollIntoView({ behavior: 'smooth' });
        
        this.renderVideos();
    }

    // ============================================================================
    // VIDEO POSITION TRACKING & RESUME FUNCTIONALITY
    // ============================================================================

    setupSeekDebouncing(player) {
        let seekTimeout = null;
        let pendingSeekTime = null;
        
        const originalCurrentTime = player.currentTime.bind(player);
        
        player.currentTime = function(time) {
            if (time === undefined) {
                return originalCurrentTime();
            }
            
            pendingSeekTime = time;
            
            if (seekTimeout) {
                clearTimeout(seekTimeout);
            }
            
            seekTimeout = setTimeout(() => {
                originalCurrentTime(pendingSeekTime);
                pendingSeekTime = null;
                seekTimeout = null;
            }, 500);
            
            return originalCurrentTime();
        };
    }

    setupVideoPositionTracking(videoId) {
        const player = this.player;
        
        player.controls(false);
        
        const savedPosition = getSavedVideoPosition(videoId);
        const shouldAutoResume = savedPosition && savedPosition.time > VIDEO_POSITION_CONFIG.resumeThreshold;
        
        if (shouldAutoResume) {
            this.shouldResume = true;
        }

        const savePosition = () => {
            if (player.isResuming) return;
            
            const currentTime = player.currentTime();
            const duration = player.duration();
            
            if (currentTime && duration && !isNaN(currentTime) && !isNaN(duration)) {
                saveVideoPosition(videoId, currentTime, duration);
            }
        };

        const startSaving = () => {
            if (this.saveTimer) clearInterval(this.saveTimer);
            this.saveTimer = setInterval(savePosition, VIDEO_POSITION_CONFIG.saveInterval * 1000);
        };

        const stopSaving = () => {
            if (this.saveTimer) {
                clearInterval(this.saveTimer);
                this.saveTimer = null;
            }
        };

        const doAutoResume = () => {
            if (this.hasResumed || player.isResuming || !this.shouldResume) return;
            
            this.hasResumed = true;
            autoResumeVideo(player, savedPosition.time);
        };

        const onMetadataLoaded = () => {
            const loadingIndicator = document.querySelector('.video-loading-indicator');
            if (loadingIndicator) {
                loadingIndicator.remove();
            }
            
            player.controls(true);
            
            
            setTimeout(doAutoResume, 50);
        };

        player.on('loadedmetadata', onMetadataLoaded);
        
        player.on('loadedmetadata', () => {
            setTimeout(() => this.syncChatSidebarHeight(), 100);
        });

        player.on('play', () => {
            if (this.shouldResume && !this.hasResumed) {
                player.pause();
                doAutoResume();
                return;
            }
            
            if (!player.isResuming) {
                startSaving();
            }
        });

        player.on('pause', () => {
            if (!player.isResuming) {
                savePosition();
            }
        });

        player.on('seeked', () => {
            if (!player.isResuming) {
                savePosition();
            }
        });

        player.on('ended', () => {
            stopSaving();
            clearVideoPosition(videoId);
            this.renderVideos();
        });

        window.addEventListener('beforeunload', savePosition);

        if (player.readyState() >= 1) {
            onMetadataLoaded();
        }
    }

    setupNormalEventListeners(player, videoId) {
        const savePosition = () => {
            if (player.isResuming) return;
            
            const currentTime = player.currentTime();
            const duration = player.duration();
            
            if (currentTime && duration && !isNaN(currentTime) && !isNaN(duration)) {
                saveVideoPosition(videoId, currentTime, duration);
            }
        };

        const startSaving = () => {
            if (this.saveTimer) clearInterval(this.saveTimer);
            this.saveTimer = setInterval(savePosition, VIDEO_POSITION_CONFIG.saveInterval * 1000);
        };

        const stopSaving = () => {
            if (this.saveTimer) {
                clearInterval(this.saveTimer);
                this.saveTimer = null;
            }
        };

        player.on('play', () => {
            if (!player.isResuming) {
                startSaving();
            }
        });

        player.on('pause', () => {
            if (!player.isResuming) {
                savePosition();
            }
        });

        player.on('seeked', () => {
            if (!player.isResuming) {
                savePosition();
            }
        });

        player.on('ended', () => {
            stopSaving();
            clearVideoPosition(videoId);
            this.renderVideos();
        });

        window.addEventListener('beforeunload', savePosition);
    }

    setupVideoTimeTracking(player, videoId) {
        let hasStartedPlaying = false;
        let lastDisplayedSecond = -1;
        
        player.on('play', () => {
            hasStartedPlaying = true;
        });
        
        player.on('timeupdate', () => {
            const currentTime = Math.floor(player.currentTime());
            
            if (currentTime > 0) {
                history.replaceState({}, '', `/${videoId}?t=${currentTime}`);
                
                if (hasStartedPlaying && currentTime !== lastDisplayedSecond) {
                    this.loadAndDisplayChatForSecond(videoId, currentTime);
                    lastDisplayedSecond = currentTime;
                }
            }
        });
        
        player.on('seeked', () => {
            const currentTime = Math.floor(player.currentTime());
            if (hasStartedPlaying) {
                const chatMessages = document.getElementById('chatMessages');
                chatMessages.innerHTML = '';
                
                this.loadedMessageIds.clear();
                
                this.loadAndDisplayChatForSecond(videoId, currentTime);
                lastDisplayedSecond = currentTime;
            }
        });
    }

    async loadAndDisplayChatForSecond(videoId, currentTime) {
        if (!this.chatTimecodes.has(currentTime)) {
            return;
        }
        
        try {
            const response = await fetch(`/api/chat/${videoId}/${currentTime}/${currentTime}`);
            if (response.ok) {
                const messages = await response.json();
                this.appendChatMessages(messages);
            }
        } catch (error) {
            console.error('Failed to load chat messages:', error);
        }
    }

    appendChatMessages(messages) {
        const chatMessages = document.getElementById('chatMessages');
        
        if (messages.length === 0) {
            return;
        }
        
        const newMessages = messages.filter(message => {
            const messageId = `${message.video_timestamp || message.timestamp || 0}_${message.commenter?.display_name || message.message?.display_name || 'unknown'}_${(message.message?.body || message.body || '').substring(0, 50)}`;
            
            if (this.loadedMessageIds.has(messageId)) {
                return false; // Skip duplicate
            }
            
            this.loadedMessageIds.add(messageId);
            return true; // Include new message
        });
        
        newMessages.sort((a, b) => {
            const timeA = a.video_timestamp || a.timestamp || 0;
            const timeB = b.video_timestamp || b.timestamp || 0;
            
            if (timeA !== timeB) {
                return timeA - timeB;
            }
            
            const originalTimeA = a.timestamp || 0;
            const originalTimeB = b.timestamp || 0;
            return originalTimeA - originalTimeB;
        });
        
        newMessages.forEach(message => {
            const messageElement = this.createChatMessageElement(message);
            chatMessages.appendChild(messageElement);
        });
        
        const allMessages = Array.from(chatMessages.children);
        if (allMessages.length > 50) {
            const messagesToRemove = allMessages.slice(0, allMessages.length - 50);
            messagesToRemove.forEach(msg => msg.remove());
            
            if (this.loadedMessageIds.size > 200) {
                const idsArray = Array.from(this.loadedMessageIds);
                this.loadedMessageIds.clear();
                idsArray.slice(-100).forEach(id => this.loadedMessageIds.add(id));
            }
        }
        
        this.syncFullscreenChat();
        
        chatMessages.scrollTo(0, chatMessages.scrollHeight);
    }

    // ============================================================================
    // CHAT FUNCTIONALITY & UI
    // ============================================================================

    toggleChat() {
        if (this.chatOpen) {
            this.closeChat();
        } else {
            this.openChat();
        }
    }

    toggleChatMode() {
        this.chatSidebarMode = !this.chatSidebarMode;
        this.saveChatSetting('chatSidebarMode', this.chatSidebarMode);
        
        if (this.chatOpen) {
            this.closeChat();
            this.openChat();
        }
        
        if (this.player && this.player.isFullscreen()) {
            if (this.chatOpen && !this.chatSidebarMode) {
                this.createFullscreenChatOverlay();
            } else {
                this.removeFullscreenChatOverlay();
            }
        }
        
        this.updateChatModeButton();
        this.updateChatSizeDropdown(); // Update dropdown visibility
    }

    openChat() {
        if (!this.currentVideo) return;
        
        const chatSidebar = document.getElementById('chatSidebar');
        const videoSection = document.querySelector('.video-section');
        
        if (chatSidebar && videoSection) {
            chatSidebar.style.display = 'flex';
            
            if (this.chatSidebarMode) {
                chatSidebar.classList.remove('overlay-mode');
                videoSection.classList.remove('chat-overlay');
                videoSection.classList.add('chat-open');
            } else {
                chatSidebar.classList.add('overlay-mode');
                videoSection.classList.add('chat-overlay');
                videoSection.classList.remove('chat-open');
                
                chatSidebar.classList.remove('chat-size-30pct', 'chat-size-50pct', 'chat-size-100pct');
                chatSidebar.classList.add(`chat-size-${this.chatSize}pct`);
            }
            
            this.chatOpen = true;
            this.saveChatSetting('chatOpen', true);
            
            const chatToggleBtn = document.getElementById('chatToggleBtn');
            if (chatToggleBtn) {
                chatToggleBtn.classList.add('chat-open');
            }
            
            const chatModeBtn = document.getElementById('chatModeBtn');
            if (chatModeBtn) {
                chatModeBtn.style.display = 'inline-flex';
            }
            
            this.updateChatSizeDropdown();
            
            setTimeout(() => this.syncChatSidebarHeight(), 50);
            
            if (this.player && this.player.isFullscreen() && !this.chatSidebarMode) {
                this.createFullscreenChatOverlay();
            }
        }
    }

    closeChat() {
        const chatSidebar = document.getElementById('chatSidebar');
        const videoSection = document.querySelector('.video-section');
        
        if (chatSidebar && videoSection) {
            chatSidebar.style.display = 'none';
            chatSidebar.classList.remove('overlay-mode', 'chat-size-30pct', 'chat-size-50pct', 'chat-size-100pct');
            videoSection.classList.remove('chat-open', 'chat-overlay');
            this.chatOpen = false;
            this.saveChatSetting('chatOpen', false);
            
            const chatToggleBtn = document.getElementById('chatToggleBtn');
            if (chatToggleBtn) {
                chatToggleBtn.classList.remove('chat-open');
            }
            
            const chatModeBtn = document.getElementById('chatModeBtn');
            if (chatModeBtn) {
                chatModeBtn.style.display = 'none';
            }
            
            this.updateChatSizeDropdown();
            
            this.removeFullscreenChatOverlay();
        }
    }

    createChatToggleButton(titleElement) {
        const existingBtn = document.getElementById('chatToggleBtn');
        if (existingBtn) {
            existingBtn.remove();
        }

        const chatToggleBtn = document.createElement('div');
        chatToggleBtn.id = 'chatToggleBtn';
        chatToggleBtn.className = 'chat-drawer-toggle';
        chatToggleBtn.style.position = 'relative';
        chatToggleBtn.style.display = 'inline-flex';
        chatToggleBtn.style.marginLeft = '10px';
        chatToggleBtn.style.top = 'auto';
        chatToggleBtn.style.right = 'auto';
        chatToggleBtn.style.transform = 'none';
        chatToggleBtn.innerHTML = '<div class="chat-drawer-icon"></div>';
        chatToggleBtn.title = 'Toggle Chat';
        
        if (this.chatOpen) {
            chatToggleBtn.classList.add('chat-open');
        }
        
        chatToggleBtn.addEventListener('click', () => {
            this.toggleChat();
        });
        
        if (titleElement) {
            titleElement.appendChild(chatToggleBtn);
        }

        return chatToggleBtn;
    }

    createChatModeButton(titleElement) {
        
        const existingBtn = document.getElementById('chatModeBtn');
        if (existingBtn) {
            existingBtn.remove();
        }

        const chatModeBtn = document.createElement('div');
        chatModeBtn.id = 'chatModeBtn';
        chatModeBtn.className = 'sidebar-toggle';
        chatModeBtn.style.position = 'relative';
        chatModeBtn.style.display = this.chatOpen ? 'inline-flex' : 'none';
        chatModeBtn.style.marginLeft = '10px';
        chatModeBtn.style.top = 'auto';
        chatModeBtn.style.right = 'auto';
        chatModeBtn.style.transform = 'none';
        chatModeBtn.innerHTML = '<div class="sidebar-icon"></div>';
        
        chatModeBtn.title = 'Toggle Sidebar';
        
        if (this.chatSidebarMode) {
            chatModeBtn.classList.add('active');
        }
        
        chatModeBtn.addEventListener('click', () => {
            this.toggleChatMode();
        });
        
        if (titleElement) {
            titleElement.appendChild(chatModeBtn);
        }

        return chatModeBtn;
    }

    updateChatModeButton() {
        const chatModeBtn = document.getElementById('chatModeBtn');
        if (chatModeBtn) {
            if (this.chatSidebarMode) {
                chatModeBtn.classList.add('active');
            } else {
                chatModeBtn.classList.remove('active');
            }
        }
    }

    createChatSizeDropdown(titleElement) {
        const existingContainer = document.getElementById('chatSizeContainer');
        if (existingContainer) {
            existingContainer.remove();
        }

        const container = document.createElement('div');
        container.id = 'chatSizeContainer';
        container.className = 'chat-size-container';
        container.style.display = this.chatOpen && !this.chatSidebarMode ? 'inline-flex' : 'none';

        const label = document.createElement('span');
        label.className = 'chat-size-label';
        label.textContent = 'Chat Overlay Size:';

        const dropdown = document.createElement('select');
        dropdown.id = 'chatSizeDropdown';
        dropdown.className = 'chat-size-dropdown';
        dropdown.title = 'Chat Overlay Size';
        
        const sizes = [
            { value: '30', label: '30%' },
            { value: '50', label: '50%' },
            { value: '100', label: '100%' }
        ];

        sizes.forEach(size => {
            const option = document.createElement('option');
            option.value = size.value;
            option.textContent = size.label;
            if (size.value === this.chatSize) {
                option.selected = true;
            }
            dropdown.appendChild(option);
        });

        dropdown.addEventListener('change', (e) => {
            this.chatSize = e.target.value;
            this.saveChatSetting('chatSize', this.chatSize);
            this.updateChatOverlaySize();
        });

        container.appendChild(label);
        container.appendChild(dropdown);

        if (titleElement) {
            titleElement.appendChild(container);
        }

        return container;
    }

    updateChatSizeDropdown() {
        const container = document.getElementById('chatSizeContainer');
        const dropdown = document.getElementById('chatSizeDropdown');
        if (container && dropdown) {
            container.style.display = this.chatOpen && !this.chatSidebarMode ? 'inline-flex' : 'none';
            dropdown.value = this.chatSize;
        }
    }

    updateChatOverlaySize() {
        const fullscreenChat = document.getElementById('fullscreenChat');
        if (fullscreenChat) {
            fullscreenChat.classList.remove('chat-size-30pct', 'chat-size-50pct', 'chat-size-100pct');
            fullscreenChat.classList.add(`chat-size-${this.chatSize}pct`);
        }
        
        const chatSidebar = document.getElementById('chatSidebar');
        if (chatSidebar && chatSidebar.classList.contains('overlay-mode')) {
            chatSidebar.classList.remove('chat-size-30pct', 'chat-size-50pct', 'chat-size-100pct');
            chatSidebar.classList.add(`chat-size-${this.chatSize}pct`);
        }
    }
    
    syncChatSidebarHeight() {
        const videoContainer = document.getElementById('videoContainer');
        const chatSidebar = document.getElementById('chatSidebar');
        
        if (chatSidebar && this.chatOpen && this.currentVideo && videoContainer) {
            const videoHeight = videoContainer.offsetHeight;
            if (videoHeight > 0) {
                chatSidebar.style.height = `${videoHeight}px`;
            }
        }
    }

    setupFullscreenChat() {
        this.player.ready(() => {
            this.player.on('fullscreenchange', () => {
                if (this.player.isFullscreen()) {
                    this.createFullscreenChatOverlay();
                } else {
                    this.removeFullscreenChatOverlay();
                }
            });
        });
    }

    createFullscreenChatOverlay() {
        if (!this.chatOpen || this.chatSidebarMode) {
            return;
        }

        this.removeFullscreenChatOverlay();

        const fullscreenChat = document.createElement('div');
        fullscreenChat.id = 'fullscreenChat';
        fullscreenChat.className = `chat-sidebar-fullscreen chat-size-${this.chatSize}pct`;

        const messagesContainer = document.createElement('div');
        messagesContainer.className = 'chat-messages';
        messagesContainer.id = 'fullscreenChatMessages';

        fullscreenChat.appendChild(messagesContainer);

        const playerEl = this.player.el();
        playerEl.appendChild(fullscreenChat);

        this.syncFullscreenChat();
    }

    removeFullscreenChatOverlay() {
        const fullscreenChat = document.getElementById('fullscreenChat');
        if (fullscreenChat) {
            fullscreenChat.remove();
        }
    }

    syncFullscreenChat() {
        if (!this.player || !this.player.isFullscreen()) {
            return;
        }
        
        const normalChatMessages = document.getElementById('chatMessages');
        const fullscreenChatMessages = document.getElementById('fullscreenChatMessages');
        
        if (normalChatMessages && fullscreenChatMessages) {
            fullscreenChatMessages.innerHTML = normalChatMessages.innerHTML;
            
            fullscreenChatMessages.scrollTop = fullscreenChatMessages.scrollHeight;
        }
    }

    applyChatDefault() {
        if (!this.hasAppliedChatDefault) {
            this.hasAppliedChatDefault = true;
            if (this.chatOpen) {
                this.openChat();
            }
        }
    }

    async loadChatTimecodes(videoId) {
        try {
            const response = await fetch(`/api/chat/${videoId}`);
            if (response.ok) {
                const data = await response.json();
                if (Array.isArray(data)) {
                    this.chatTimecodes = new Set(data);
                } else {
                    this.chatTimecodes = new Set();
                    console.log('No chat timecodes available for this video');
                }
            } else {
                this.chatTimecodes = new Set();
            }
        } catch (error) {
            console.error('Failed to load chat timecodes:', error);
            this.chatTimecodes = new Set();
        }
    }

    createChatMessageElement(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';
        
        if (message.message && message.message.user_badges) {
            message.message.user_badges.forEach(badge => {
                const badgeImg = this.createCachedImage(
                    `/api/emote/twitchBadges/${badge._id}/${badge.version}`,
                    'chat-badge',
                    badge._id,
                    badge._id,
                    { height: '16px' }
                );
                badgeImg.style.marginRight = '4px';
                badgeImg.style.verticalAlign = 'middle';
                messageDiv.appendChild(badgeImg);
            });
        }
        
        const username = document.createElement('span');
        username.className = 'chat-username';
        username.textContent = (message.message && message.message.display_name) || 
                              message.commenter?.display_name || 
                              'Anonymous';
        if (message.message && message.message.user_color) {
            username.style.color = message.message.user_color;
        }
        messageDiv.appendChild(username);
        
        const colon = document.createElement('span');
        colon.className = 'colon';
        colon.textContent = ': ';
        messageDiv.appendChild(colon);
        
        const messageText = document.createElement('span');
        messageText.className = 'chat-text';
        
        if (message.message && message.message.fragments) {
            message.message.fragments.forEach(fragment => {
                if (fragment.emoticon) {
                    const emoteId = fragment.emoticon.emoticon_id;
                    const emoteImg = this.createCachedImage(
                        `/api/emote/firstParty/${emoteId}`,
                        'chat-emote',
                        fragment.text,
                        fragment.text,
                        { height: '20px' }
                    );
                    emoteImg.style.verticalAlign = 'middle';
                    emoteImg.style.margin = '0 2px';
                    emoteImg.onerror = function() {
                        if (this.src.includes('firstParty')) {
                            this.src = `/api/emote/thirdParty/${emoteId}`;
                        } else {
                            console.warn(`Direct emote not found: ${emoteId} (${fragment.text})`);
                            this.style.display = 'none';
                            const textSpan = document.createElement('span');
                            textSpan.textContent = fragment.text;
                            this.parentNode.insertBefore(textSpan, this.nextSibling);
                        }
                    };
                    messageText.appendChild(emoteImg);
                } else {
                    const words = fragment.text.split(/\s+/);
                    words.forEach((word, index) => {
                        const cheerMatch = word.match(/^([a-zA-Z]+)(\d+)$/);
                        if (cheerMatch && this.emoteCache.cheers[cheerMatch[1]]) {
                            const provider = cheerMatch[1];
                            const bits = parseInt(cheerMatch[2]);
                            
                            let cheerAmount = 1;
                            for (const value of this.emoteCache.cheers[provider]) {
                                if (bits >= value) cheerAmount = value;
                            }
                            
                            const cheerImg = document.createElement('img');
                            cheerImg.className = 'chat-emote';
                            cheerImg.src = `/api/emote/twitchBits/${provider}/${cheerAmount}`;
                            cheerImg.alt = word;
                            cheerImg.title = word;
                            cheerImg.style.height = '20px';
                            cheerImg.style.verticalAlign = 'middle';
                            cheerImg.style.margin = '0 2px';
                            cheerImg.onerror = function() {
                                console.warn(`Cheer not found: ${provider}/${cheerAmount} (${word})`);
                                this.style.display = 'none';
                                const textSpan = document.createElement('span');
                                textSpan.textContent = word;
                                textSpan.style.fontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Roboto", "Helvetica", "Arial", sans-serif';
                                this.parentNode.insertBefore(textSpan, this.nextSibling);
                            };
                            messageText.appendChild(cheerImg);
                            
                            const numberSpan = document.createElement('span');
                            numberSpan.textContent = bits + ' ';
                            numberSpan.style.color = '#ff6347'; // Orange-red for bit numbers
                            numberSpan.style.fontWeight = 'bold';
                            messageText.appendChild(numberSpan);
                            
                            return; // Skip other checks for this word
                        }
                        
                        let emoteId = null;
                        let emoteType = null;
                        
                        if (this.emoteCache.thirdParty[word]) {
                            emoteId = this.emoteCache.thirdParty[word];
                            emoteType = 'thirdParty';
                        } else if (this.emoteCache.firstParty[word]) {
                            emoteId = this.emoteCache.firstParty[word];
                            emoteType = 'firstParty';
                        }
                        
                        if (emoteId && emoteType) {
                            const emoteImg = this.createCachedImage(
                                `/api/emote/${emoteType}/${emoteId}`,
                                'chat-emote',
                                word,
                                word,
                                { height: '20px' }
                            );
                            emoteImg.style.height = '20px';
                            emoteImg.style.verticalAlign = 'middle';
                            emoteImg.style.margin = '0 2px';
                            emoteImg.onerror = function() {
                                console.warn(`Mapped emote not found: ${word} -> ${emoteType}/${emoteId}`);
                                this.style.display = 'none';
                                const textSpan = document.createElement('span');
                                textSpan.textContent = word + (index < words.length - 1 ? ' ' : '');
                                textSpan.style.fontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Roboto", "Helvetica", "Arial", sans-serif';
                                this.parentNode.insertBefore(textSpan, this.nextSibling);
                            };
                            messageText.appendChild(emoteImg);
                        } else {
                            const textSpan = document.createElement('span');
                            textSpan.textContent = word;
                            textSpan.style.fontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Roboto", "Helvetica", "Arial", sans-serif';
                            messageText.appendChild(textSpan);
                        }
                        
                        if (index < words.length - 1) {
                            messageText.appendChild(document.createTextNode(' '));
                        }
                    });
                }
            });
        } else {
            const textSpan = document.createElement('span');
            textSpan.textContent = message.message?.body || message.body || '';
            textSpan.style.fontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Roboto", "Helvetica", "Arial", sans-serif';
            messageText.appendChild(textSpan);
        }
        
        messageDiv.appendChild(messageText);
        return messageDiv;
    }

    loadChatSetting(settingName, defaultValue) {
        try {
            const saved = localStorage.getItem(`chat_${settingName}`);
            return saved !== null ? JSON.parse(saved) : defaultValue;
        } catch (e) {
            return defaultValue;
        }
    }

    saveChatSetting(settingName, value) {
        try {
            localStorage.setItem(`chat_${settingName}`, JSON.stringify(value));
        } catch (e) {
            console.warn('Failed to save chat setting:', settingName, e);
        }
    }

    // ============================================================================
    // URL & NAVIGATION HANDLING
    // ============================================================================

    checkURLForVideoAndTime() {
        const path = window.location.pathname;
        const searchParams = new URLSearchParams(window.location.search);
        
        const videoId = path.slice(1);
        
        if (videoId && videoId !== '') {
            this.loadVideo(videoId);
            
            const timeParam = searchParams.get('t');
            if (timeParam) {
                const seekTime = parseInt(timeParam, 10);
                if (seekTime > 0 && this.player) {
                    this.player.ready(() => {
                        this.player.currentTime(seekTime);
                    });
                }
            }
        }
    }

    // ============================================================================
    // UTILITY & HELPER METHODS
    // ============================================================================


    createCachedImage(src, className, alt = '', title = '', style = {}) {
        if (this.imageCache.has(src)) {
            const cachedImg = this.imageCache.get(src);
            const img = cachedImg.cloneNode();
            img.className = className;
            img.alt = alt;
            img.title = title;
            Object.assign(img.style, style);
            return img;
        }

        const img = document.createElement('img');
        img.className = className;
        img.alt = alt;
        img.title = title;
        img.src = src;
        Object.assign(img.style, style);

        img.onload = () => {
            this.imageCache.set(src, img.cloneNode());
        };

        return img;
    }

    handleKonamiCode(keyCode) {
        if (keyCode === this.konamiSequence[this.konamiProgress.length]) {
            this.konamiProgress.push(keyCode);
            
            if (this.konamiProgress.length === this.konamiSequence.length) {
                this.executeKonamiCode();
                this.konamiProgress = [];
            }
        } else {
            this.konamiProgress = [];
            if (keyCode === this.konamiSequence[0]) {
                this.konamiProgress.push(keyCode);
            }
        }
    }

    executeKonamiCode() {
        this.clearAllStoredPositions();
        
        this.chatSize = '30';
        this.saveChatSetting('chatSize', this.chatSize);
        
        const chatSizeDropdown = document.getElementById('chatSizeSelect');
        if (chatSizeDropdown) {
            chatSizeDropdown.value = this.chatSize;
        }
        
        this.updateChatOverlaySize();
        
        if (this.player && this.currentVideo) {
            this.player.currentTime(0);
            this.hasResumed = false;
            this.shouldResume = false;
        }
        
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.9);
            color: #fff;
            padding: 20px 40px;
            border-radius: 10px;
            font-size: 18px;
            font-weight: bold;
            z-index: 10000;
            border: 2px solid #00ff00;
            box-shadow: 0 0 20px rgba(0, 255, 0, 0.5);
        `;
        notification.textContent = '🎮 KONAMI CODE ACTIVATED! All saved positions cleared! 🎮';
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.remove();
            this.renderVideos();
        }, 3000);
    }

    clearAllStoredPositions() {
        const keys = Object.keys(localStorage);
        let videoPositionCount = 0;
        let chatSettingsCount = 0;
        let otherCount = 0;
        
        keys.forEach(key => {
            if (key.startsWith('video_position_')) {
                videoPositionCount++;
            } else if (key.startsWith('chat_')) {
                chatSettingsCount++;
            } else {
                otherCount++;
            }
            localStorage.removeItem(key);
        });
        
        console.log(`Konami Code: Cleared ${videoPositionCount} video positions, ${chatSettingsCount} chat settings, and ${otherCount} other localStorage items`);
        
        this.chatOpen = false;
        this.chatSidebarMode = false; // false = overlay (default), true = sidebar
        this.chatSize = '50'; // Reset to default size
        this.hasAppliedChatDefault = false;
        
        this.closeChat();
    }

    checkURLForVideo() {
        this.checkURLForVideoAndTime();
    }

    resetToInitialState() {
        if (this.player) {
            this.player.dispose();
            this.player = null;
        }

        this.currentVideo = null;
        this.resumeState = 'none';
        this.hasResumed = false;
        this.shouldResume = false;

        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }


        this.hasAppliedChatDefault = false;
        this.chatOpen = false; // Reset internal state without saving to localStorage

        this.chatTimecodes = new Set();
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }

        const chatToggleBtn = document.getElementById('chatToggleBtn');
        const chatModeBtn = document.getElementById('chatModeBtn');
        if (chatToggleBtn) chatToggleBtn.remove();
        if (chatModeBtn) chatModeBtn.remove();

        document.getElementById('videoPlaceholder').style.display = 'flex';
        const videoPlayer = document.getElementById('videoPlayer');
        if (videoPlayer) {
            videoPlayer.style.display = 'none';
        }
        document.getElementById('infoSection').style.display = 'none';

        document.title = 'Macaw45 VOD Archive';
        history.replaceState(null, '', '/');

        this.removeFullscreenChatOverlay();

        const videoSection = document.querySelector('.video-section');
        if (videoSection) {
            videoSection.classList.remove('chat-open', 'chat-overlay');
        }

        const chatSidebar = document.getElementById('chatSidebar');
        if (chatSidebar) {
            chatSidebar.style.display = 'none';
            chatSidebar.classList.remove('overlay-mode');
        }
    }
}

const archive = new VODArchive();

window.addEventListener('popstate', (e) => {
    if (e.state && e.state.videoId) {
        archive.loadVideo(e.state.videoId);
    } else {
        archive.resetToInitialState();
    }
});

document.ondblclick = function (e) {
    e.preventDefault();
};