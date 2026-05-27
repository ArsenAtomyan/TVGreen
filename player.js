/**
 * player.js
 * Main IPTV player application.
 *
 * Key features:
 *  - Dynamic buffer management: measures real download speed per segment,
 *    adjusts HLS.js maxBufferLength automatically (longer buffer = fewer freezes
 *    on slow connections). Inspired by FreeTV's stability approach.
 *  - TV-style channel dial: type digits, navigate after 1.8s idle.
 *  - Configurable VLC-style hotkeys.
 *  - Auto-hiding OSD controls.
 *  - Robust HLS error recovery with retry logic.
 */

'use strict';

// ============================================================
//  NetworkMonitor
//  Tracks per-segment download speed with an exponentially
//  weighted moving average (recent samples weigh more).
//  Recommends a buffer target length in seconds.
// ============================================================
class NetworkMonitor {
  constructor() {
    this.samples          = [];   // bandwidth samples in bps
    this.maxSamples       = 12;
    this.currentBandwidth = 2_000_000; // 2 Mbps initial guess
  }

  /** Record one completed segment load. */
  addSample(bytes, durationMs) {
    if (durationMs <= 0 || bytes <= 0) return;
    const bps = (bytes * 8 * 1000) / durationMs;
    this.samples.push(bps);
    if (this.samples.length > this.maxSamples) this.samples.shift();

    // Weighted average: each older sample is worth 80% of the next newer one
    let weightedSum = 0, weightSum = 0, w = 1;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      weightedSum += this.samples[i] * w;
      weightSum   += w;
      w           *= 0.8;
    }
    this.currentBandwidth = weightedSum / weightSum;
  }

  /**
   * Recommend buffer length in seconds based on measured speed.
   * Slower connection → longer pre-buffer to absorb speed dips.
   */
  getRecommendedBufferLength() {
    const mbps = this.currentBandwidth / 1_000_000;
    if (mbps >= 20) return 15;
    if (mbps >= 10) return 25;
    if (mbps >=  5) return 40;
    if (mbps >=  2) return 60;
    if (mbps >=  1) return 90;
    return 120; // < 1 Mbps: build a 2-minute cushion
  }

  /** Human-readable speed string. */
  getSpeedLabel() {
    const mbps = this.currentBandwidth / 1_000_000;
    if (mbps >= 1) return mbps.toFixed(2) + ' Mbps';
    return (this.currentBandwidth / 1000).toFixed(0) + ' Kbps';
  }
}

// ============================================================
//  App
// ============================================================
const App = {
  channels:        [],
  playlistChannels: [],   // channels from M3U playlists only (before custom merge)
  currentIndex:    -1,
  hls:            null,
  networkMonitor: new NetworkMonitor(),

  // Channel dial state
  dialBuffer:   '',
  dialTimer:    null,
  _editingId:   null,

  // OSD / control auto-hide
  controlsTimer: null,

  // Settings stats update interval
  statsInterval: null,

  // Playback state
  isStopped:  false,
  isMuted:    false,
  volume:     1.0,

  // DOM refs (populated in cacheElements)
  el: {},

  // ============================================================
  //  Bootstrap
  // ============================================================
  init() {
    Settings.load();
    this.cacheElements();
    this.setupSetupScreen();
    this.setupSettingsModal();
    this.setupControlButtons();
    this.setupKeyboard();
    this.setupOSD();
    this.setupAudioTrackBtn();

    if (Settings.hasAnyUrl()) {
      this.loadAllPlaylists();
    } else {
      this._hideLoader();
      this.showSetup();
    }
  },

  cacheElements() {
    const $ = id => document.getElementById(id);
    this.el = {
      setupScreen:   $('setup-screen'),
      setupUrl:      $('setup-url'),
      setupUrl2:     $('setup-url2'),
      setupBtn:      $('setup-btn'),
      setupUpload:   $('setup-upload'),
      setupError:    $('setup-error'),
      app:           $('app'),
      pageLoader:    $('page-loader'),
      sidebar:       $('sidebar'),
      channelSearch: $('channel-search'),
      groupTabs:     $('group-tabs'),
      groupArrowL:   $('group-arrow-left'),
      groupArrowR:   $('group-arrow-right'),
      channelList:   $('channel-list'),
      video:         $('video'),
      channelDial:    $('channel-dial'),
      dialNumber:     $('dial-number'),
      dialName:       $('dial-name'),
      buffering:      $('buffering'),
      bufferLabel:   $('buffer-label'),
      topbar:        $('player-topbar'),
      chBadgeTop:    $('ch-badge-top'),
      nowPlayingName:$('now-playing-name'),
      settingsBtn:   $('settings-btn'),
      controls:      $('player-controls'),
      prevBtn:       $('prev-btn'),
      playBtn:       $('play-btn'),
      playIcon:      $('play-icon'),
      stopBtn:       $('stop-btn'),
      nextBtn:       $('next-btn'),
      muteBtn:       $('mute-btn'),
      volIcon:       $('vol-icon'),
      volumeSlider:  $('volume-slider'),
      chBadge:       $('ch-badge'),
      chNameBar:     $('ch-name-bar'),
      audioTrackWrap:  $('audio-track-wrap'),
      audioTrackBtn:   $('audio-track-btn'),
      audioTrackCount: $('audio-track-count'),
      audioTrackMenu:  $('audio-track-menu'),
      audioTrackList:  $('audio-track-list'),
      menuBtn:       $('menu-btn'),
      fullscreenBtn: $('fullscreen-btn'),
      fsIcon:        $('fs-icon'),
      settingsModal: $('settings-modal'),
      modalBackdrop: $('modal-backdrop'),
      modalClose:    $('modal-close'),
      settingsUrl:   $('settings-url'),
      settingsUrl2:  $('settings-url2'),
      applyUrlBtn:   $('apply-url-btn'),
      uploadM3u:     $('upload-m3u'),
      cchName:       $('cch-name'),
      cchGroup:      $('cch-group'),
      cchUrl:        $('cch-url'),
      cchNumber:     $('cch-number'),
      cchLogo:       $('cch-logo'),
      cchAddBtn:     $('cch-add-btn'),
      cchCancelBtn:  $('cch-cancel-btn'),
      cchError:      $('cch-error'),
      customChList:  $('custom-ch-list'),
      hotkeyList:    $('hotkey-list'),
      resetHotkeys:  $('reset-hotkeys-btn'),
      bufferMode:    $('buffer-mode'),
      statSpeed:     $('stat-speed'),
      statBuffer:    $('stat-buffer'),
      statQuality:   $('stat-quality'),
      statDropped:   $('stat-dropped'),
      toast:         $('toast'),
      navZoneHint:   $('nav-zone-hint'),
    };
  },

  // ============================================================
  //  Setup Screen
  // ============================================================
  showSetup() {
    this.el.setupScreen.classList.remove('hidden');
    this.el.app.classList.add('hidden');
  },

  hideSetup() {
    this._hideLoader();
    this.el.setupScreen.classList.add('hidden');
    this.el.app.classList.remove('hidden');
  },

  _hideLoader() {
    this.el.pageLoader.classList.add('hidden');
  },

  setupSetupScreen() {
    this.el.setupBtn.addEventListener('click', () => {
      const url1 = this.el.setupUrl.value.trim();
      const url2 = this.el.setupUrl2.value.trim();
      if (!url1) { this.showSetupError('Please enter at least Playlist 1 URL.'); return; }
      Settings.m3uUrls = [url1, url2];
      Settings.save();
      this.loadAllPlaylists({ fromSetup: true });
    });

    this.el.setupUrl.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.el.setupBtn.click();
    });
    this.el.setupUrl2.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.el.setupBtn.click();
    });

    this.el.setupUpload.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => this.loadAllPlaylists({ texts: [ev.target.result], fromSetup: true });
      reader.readAsText(file);
    });
  },

  showSetupError(msg) {
    this.el.setupError.textContent = msg;
    this.el.setupError.classList.remove('hidden');
  },

  // ============================================================
  //  Playlist Loading
  // ============================================================

  /**
   * Fetch all saved URLs (or provided texts), parse each, then merge
   * channels with sequential numbering: playlist 2 starts after playlist 1.
   *
   * @param {object}   [opts]
   * @param {boolean}  [opts.fromSetup]  - triggered from setup screen
   * @param {string[]} [opts.texts]      - pre-loaded M3U texts (file uploads)
   */
  async loadAllPlaylists({ fromSetup = false, texts = null } = {}) {
    if (fromSetup) {
      this.el.setupBtn.textContent = 'Loading…';
      this.el.setupBtn.disabled = true;
      this.el.setupError.classList.add('hidden');
    }

    try {
      let allChannels = [];

      if (texts) {
        // File upload(s) — treat as playlist slot 1 only
        allChannels = this._mergeChannelLists(texts.map(t => parseM3U(t)));
      } else {
        // Fetch all non-empty URL slots in parallel
        const urls = Settings.m3uUrls.filter(u => u.trim() !== '');
        if (urls.length === 0) throw new Error('No playlist URL configured.');

        const fetched = await Promise.allSettled(urls.map(url => this._fetchM3U(url)));

        const parsedLists = [];
        for (let i = 0; i < fetched.length; i++) {
          if (fetched[i].status === 'fulfilled') {
            const ch = parseM3U(fetched[i].value);
            if (ch.length > 0) parsedLists.push(ch);
          } else {
            // One URL failed — warn but don't abort if at least one succeeded
            console.warn('Playlist ' + (i + 1) + ' failed:', fetched[i].reason?.message);
          }
        }

        if (parsedLists.length === 0)
          throw new Error('All playlists failed to load. Check your URLs.');

        allChannels = this._mergeChannelLists(parsedLists);
      }

      this.playlistChannels = allChannels;
      this.channels = this._mergeCustomChannels(allChannels);
      this.hideSetup();
      this.renderChannelList();

      // Restore last-watched channel or start at 0
      const lastIdx = parseInt(localStorage.getItem('iptv_last_channel') || '0', 10);
      this.playChannel(Math.min(lastIdx, allChannels.length - 1));

      // Auto-fullscreen on first load
      this._requestFullscreen();

    } catch (err) {
      if (fromSetup) {
        this.showSetupError(err.message);
        this.el.setupBtn.textContent = 'Load Channels';
        this.el.setupBtn.disabled = false;
      } else {
        this._hideLoader();
        this.showSetup();
        this.showSetupError('Could not reload your playlist: ' + err.message);
      }
    }
  },

  /** Fetch a single M3U URL, falling back to a CORS proxy if needed. */
  async _fetchM3U(url) {
    // 1st attempt — direct fetch
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) return res.text();
      throw new Error('HTTP ' + res.status);
    } catch (directErr) {
      // Direct failed (likely CORS) — try proxy
    }

    // 2nd attempt — corsproxy.io (free, reliable, no sign-up needed)
    const proxies = [
      'https://corsproxy.io/?' + encodeURIComponent(url),
      'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    ];

    for (const proxyUrl of proxies) {
      try {
        const res = await fetch(proxyUrl);
        if (res.ok) {
          console.info('[IPTV] Loaded via proxy:', proxyUrl.split('?')[0]);
          return res.text();
        }
      } catch (_) {}
    }

    throw new Error(
      'Could not fetch playlist "' + url + '".\n' +
      'Direct and proxy attempts both failed. Try downloading the M3U file and uploading it instead.'
    );
  },

  /**
   * Merge multiple channel lists with sequential numbering.
   * List 2 channel numbers start at max(list1 numbers) + 1, etc.
   */
  _mergeChannelLists(lists) {
    let offset = 0;
    let globalIndex = 0;
    const merged = [];

    for (const list of lists) {
      // Find the highest channel number in this list
      const maxNum = list.reduce((m, c) => Math.max(m, c.number || 0), 0);

      for (const ch of list) {
        merged.push({
          ...ch,
          number: offset + ch.number,
          index:  globalIndex++,
        });
      }

      // Next playlist starts after this one's highest number
      offset += maxNum;
    }

    return merged;
  },

  // ============================================================
  //  Channel List Rendering
  // ============================================================
  activeGroup: 'All',

  renderChannelList() {
    const groups = ['All', ...new Set(this.channels.map(c => c.group))];

    // Group tabs
    this.el.groupTabs.innerHTML = groups.map(g =>
      `<button class="group-tab${g === this.activeGroup ? ' active' : ''}" data-group="${this._esc(g)}">${this._esc(g)}</button>`
    ).join('');

    this.el.groupTabs.querySelectorAll('.group-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeGroup = btn.dataset.group;
        this.el.groupTabs.querySelectorAll('.group-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderChannelItems();
      });
    });

    this._setupGroupArrows();
    this.renderChannelItems();

    // Search
    this.el.channelSearch.addEventListener('input', () => this.renderChannelItems());
  },

  _setupGroupArrows() {
    const tabs = this.el.groupTabs;
    const btnL = this.el.groupArrowL;
    const btnR = this.el.groupArrowR;

    const updateArrows = () => {
      const atStart = tabs.scrollLeft <= 4;
      const atEnd   = tabs.scrollLeft >= tabs.scrollWidth - tabs.clientWidth - 4;
      btnL.classList.toggle('hidden', atStart);
      btnR.classList.toggle('hidden', atEnd || tabs.scrollWidth <= tabs.clientWidth);
    };

    // Scroll by ~3 tabs worth on each click
    btnL.addEventListener('click', () => { tabs.scrollLeft -= 140; });
    btnR.addEventListener('click', () => { tabs.scrollLeft += 140; });

    tabs.addEventListener('scroll', updateArrows, { passive: true });

    // Also support mouse-wheel horizontal scroll on the tab row
    tabs.addEventListener('wheel', e => {
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
        e.preventDefault();
        tabs.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Run once after render so arrows reflect initial state
    requestAnimationFrame(updateArrows);
  },

  renderChannelItems() {
    const query = this.el.channelSearch.value.toLowerCase();
    const list  = this.channels.filter(c => {
      const inGroup  = this.activeGroup === 'All' || c.group === this.activeGroup;
      const inSearch = !query || c.name.toLowerCase().includes(query);
      return inGroup && inSearch;
    });

    if (list.length === 0) {
      this.el.channelList.innerHTML = '<div style="padding:24px;text-align:center;color:#5a5a80;font-size:13px;">No channels found</div>';
      return;
    }

    this.el.channelList.innerHTML = list.map(c => {
      const active = c.index === this.currentIndex ? ' active' : '';
      const logo   = c.logo
        ? `<img class="ch-logo" src="${this._esc(c.logo)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
        : `<div class="ch-logo-placeholder"></div>`;
      return `
        <div class="channel-item${active}" data-index="${c.index}">
          <span class="ch-num">${c.number}</span>
          ${logo}
          <span class="ch-item-name">${this._esc(c.name)}</span>
        </div>
      `;
    }).join('');

    this.el.channelList.querySelectorAll('.channel-item').forEach(item => {
      item.addEventListener('click', () => {
        this._clearNavFocus();
        this.playChannel(parseInt(item.dataset.index, 10));
      });
    });
  },

  scrollActiveIntoView() {
    const active = this.el.channelList.querySelector('.channel-item.active');
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },

  // ============================================================
  //  Playback — Channel Switching
  // ============================================================
  playChannel(index) {
    if (index < 0 || index >= this.channels.length) return;
    this.currentIndex = index;
    this.isStopped    = false;

    const ch = this.channels[index];
    this._updateNowPlaying(ch);
    this.renderChannelItems();
    this.scrollActiveIntoView();
    localStorage.setItem('iptv_last_channel', index);
    this._resetAudioTracks();

    // Destroy previous HLS instance cleanly
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.el.video.src = '';
    this.showBuffering(true);

    if (Hls.isSupported()) {
      this.hls = this._createHls();
      // attachMedia FIRST, then loadSource — correct HLS.js order
      this.hls.attachMedia(this.el.video);
      this.hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        this.hls.loadSource(ch.url);
      });
      this.hls.once(Hls.Events.MANIFEST_PARSED, () => {
        this._playMuted();
      });
    } else if (this.el.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.el.video.src = ch.url;
      this._playMuted();
      this._watchNativeAudioTracks();
    } else {
      this.el.video.src = ch.url;
      this._playMuted();
      this._watchNativeAudioTracks();
    }
  },

  /**
   * Merge custom channels into the playlist channel list.
   *
   * Rules:
   *  - Custom channels with a fixed number are inserted at that exact position.
   *    All channels already at that number or above are shifted up by 1 to make room.
   *    Fixed-number channels are processed in ascending order so shifts compose correctly.
   *  - Custom channels without a fixed number are appended at the end.
   *  - The final list is sorted by number, then re-indexed.
   */
  _mergeCustomChannels(playlistChannels) {
    if (!Settings.customChannels.length) return playlistChannels;

    // Working copy of playlist channels
    let merged = playlistChannels.map(c => ({ ...c }));

    // Split custom channels into fixed-number and auto
    const fixedCCs = Settings.customChannels
      .filter(cc => cc.number && cc.number > 0)
      .sort((a, b) => a.number - b.number); // lowest first — critical for correct shift order

    const autoCCs = Settings.customChannels.filter(cc => !cc.number || cc.number <= 0);

    // Insert fixed-number channels one by one, shifting on each insertion
    for (const cc of fixedCCs) {
      const insertAt = cc.number;

      // Shift every existing channel at insertAt or above up by 1
      merged = merged.map(ch =>
        ch.number >= insertAt ? { ...ch, number: ch.number + 1 } : ch
      );

      // Insert the new channel at insertAt
      merged.push({
        number:    insertAt,
        name:      cc.name,
        url:       cc.url,
        logo:      cc.logo || '',
        id:        cc.id   || '',
        group:     cc.group || 'Custom',
        _customId: cc.id,
      });
    }

    // Sort so the list is in order before appending auto channels
    merged.sort((a, b) => a.number - b.number);

    // Append auto-numbered channels after the highest existing number
    let nextNum = merged.reduce((m, c) => Math.max(m, c.number || 0), 0) + 1;
    for (const cc of autoCCs) {
      merged.push({
        number:    nextNum++,
        name:      cc.name,
        url:       cc.url,
        logo:      cc.logo || '',
        id:        cc.id   || '',
        group:     cc.group || 'Custom',
        _customId: cc.id,
      });
    }

    // Re-assign sequential indices (numbers are preserved as-is)
    return merged.map((ch, i) => ({ ...ch, index: i }));
  },
  _initialLoad: true,

  /** Mutes only on the very first load. After that respects the user's mute state. */
  _playMuted() {
    const v = this.el.video;
    if (this._initialLoad) {
      v.muted      = true;
      this.isMuted = true;
      this._initialLoad = false;
    } else {
      v.muted = this.isMuted;
    }
    v.volume = this.volume;
    v.play().catch(() => {});
    this._updateVolumeUI();
  },

  // ============================================================
  //  HLS.js Instance Factory — the anti-freeze core
  // ============================================================
  _createHls() {
    const mode   = Settings.bufferMode;
    const netBuf = this.networkMonitor.getRecommendedBufferLength();

    // Per-mode buffer ceilings
    let maxBufferLength, maxMaxBufferLength, abrDefaultEstimate, abrUpFactor;
    switch (mode) {
      case 'low':
        maxBufferLength      = 15;
        maxMaxBufferLength   = 30;
        abrDefaultEstimate   = 8_000_000;  // assume fast
        abrUpFactor          = 0.9;        // upgrade quality quickly
        break;
      case 'medium':
        maxBufferLength      = 45;
        maxMaxBufferLength   = 90;
        abrDefaultEstimate   = 3_000_000;
        abrUpFactor          = 0.65;
        break;
      case 'high':
        maxBufferLength      = 90;
        maxMaxBufferLength   = 300;
        abrDefaultEstimate   = 500_000;    // assume very slow
        abrUpFactor          = 0.4;        // upgrade quality slowly
        break;
      default: // 'auto'
        maxBufferLength      = netBuf;
        maxMaxBufferLength   = 300;
        abrDefaultEstimate   = Math.min(this.networkMonitor.currentBandwidth * 0.9, 8_000_000);
        abrUpFactor          = 0.5;
    }

    const hlsConfig = {
      // Worker enables off-main-thread demuxing — smoother UI
      enableWorker: true,

      // Never use low-latency mode for IPTV — it reduces buffering too aggressively
      lowLatencyMode: false,

      // How much previously-played video to keep (allows seamless seek-back)
      backBufferLength: Math.min(maxBufferLength * 2, 180),

      // Forward buffer target (grows dynamically in auto mode)
      maxBufferLength,
      maxMaxBufferLength,

      // Maximum RAM for buffer (100 MB — generous but safe)
      maxBufferSize: 100 * 1000 * 1000,

      // Tolerate up to 2-second gaps in the buffer before stalling
      maxBufferHole: 2,

      // If video stalls, nudge the playhead by this many seconds
      nudgeOffset: 0.3,
      nudgeMaxRetry: 12,

      // Let HLS.js test the actual bitrate of each level
      abrMaxWithRealBitrate: true,

      // Start with conservative estimate (avoids buffering during initial quality selection)
      abrEwmaDefaultEstimate: abrDefaultEstimate,

      // Only use 85% of estimated bandwidth (leaves headroom for network jitter)
      abrBandWidthFactor: 0.85,

      // Upgrade quality slowly, downgrade quickly — stability over resolution
      abrBandWidthUpFactor: abrUpFactor,

      // Auto quality selection on start
      startLevel: -1,

      // Load segments progressively (reduces time-to-first-frame)
      progressive: true,

      // ---- Aggressive retry / error recovery ----
      fragLoadingMaxRetry:            10,
      manifestLoadingMaxRetry:        8,
      levelLoadingMaxRetry:           8,
      fragLoadingRetryDelay:          500,
      manifestLoadingRetryDelay:      500,
      levelLoadingRetryDelay:         500,
      fragLoadingMaxRetryTimeout:     64_000,
      manifestLoadingMaxRetryTimeout: 32_000,
    };

    const hls = new Hls(hlsConfig);

    // ---- Per-segment bandwidth sampling ----
    hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
      const stats = data.frag?.stats;
      if (stats) {
        const bytes = stats.total || 0;
        const ms    = (stats.loading?.end || 0) - (stats.loading?.start || 0);
        this.networkMonitor.addSample(bytes, ms);

        // Dynamic buffer adjustment in auto mode:
        // if measured recommendation differs by > 10s from current target, update it
        if (Settings.bufferMode === 'auto') {
          const recommended = this.networkMonitor.getRecommendedBufferLength();
          if (Math.abs(recommended - hls.config.maxBufferLength) > 10) {
            hls.config.maxBufferLength = recommended;
          }
        }
      }
    });

    // ---- Error recovery ----
    let mediaRecoveryAttempts = 0;

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return; // non-fatal: HLS.js handles internally

      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          // Transient network issue — wait and retry
          console.warn('[HLS] Network error:', data.details, '— retrying in 2s');
          this.showBuffering(true, 'Network error — retrying…');
          setTimeout(() => {
            try { hls.startLoad(); } catch (_) {}
          }, 2000);
          break;

        case Hls.ErrorTypes.MEDIA_ERROR:
          // Codec / media pipeline error — attempt recovery
          if (mediaRecoveryAttempts < 3) {
            console.warn('[HLS] Media error — attempting recovery #' + (++mediaRecoveryAttempts));
            try { hls.recoverMediaError(); } catch (_) {}
          } else {
            // Recovery failed — reload the same channel after delay
            console.error('[HLS] Media recovery failed, restarting stream');
            this.showBuffering(true, 'Stream error — restarting…');
            setTimeout(() => { this.playChannel(this.currentIndex); }, 4000);
          }
          break;

        default:
          console.error('[HLS] Fatal error:', data);
          this.showBuffering(true, 'Stream unavailable — retrying…');
          setTimeout(() => { this.playChannel(this.currentIndex); }, 5000);
      }
    });

    // Reset media recovery counter on successful fragment load
    hls.on(Hls.Events.FRAG_LOADED, () => { mediaRecoveryAttempts = 0; });

    // Hide buffering spinner when data arrives
    hls.on(Hls.Events.BUFFER_APPENDED, () => {
      if (!this.el.video.paused) this.showBuffering(false);
    });

    // ---- Audio track support ----
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_evt, data) => {
      this._onHlsAudioTracksUpdated(data.audioTracks || []);
    });
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_evt, data) => {
      this._renderAudioTrackList();
    });

    return hls;
  },

  // ============================================================
  //  Audio Track Support
  // ============================================================

  /** Set up the audio track button toggle and close-on-outside-click. */
  setupAudioTrackBtn() {
    this.el.audioTrackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !this.el.audioTrackMenu.classList.contains('hidden');
      this._closeAudioMenu();
      if (!isOpen) this._openAudioMenu();
    });

    // Close menu when clicking anywhere else
    document.addEventListener('click', (e) => {
      if (!this.el.audioTrackWrap.contains(e.target)) {
        this._closeAudioMenu();
      }
    });
  },

  _openAudioMenu() {
    this._renderAudioTrackList();
    this.el.audioTrackMenu.classList.remove('hidden');
    this.el.audioTrackBtn.classList.add('active');
  },

  _closeAudioMenu() {
    this.el.audioTrackMenu.classList.add('hidden');
    this.el.audioTrackBtn.classList.remove('active');
  },

  /** Called by HLS.js AUDIO_TRACKS_UPDATED event. */
  _onHlsAudioTracksUpdated(tracks) {
    if (tracks.length > 1) {
      this.el.audioTrackWrap.classList.remove('hidden');
      this.el.audioTrackCount.textContent = tracks.length;
    } else {
      this.el.audioTrackWrap.classList.add('hidden');
      this._closeAudioMenu();
    }
  },

  /** Watch native HTMLVideoElement audioTracks (Safari / native HLS). */
  _watchNativeAudioTracks() {
    const tracks = this.el.video.audioTracks;
    if (!tracks) return;

    const update = () => {
      if (tracks.length > 1) {
        this.el.audioTrackWrap.classList.remove('hidden');
        this.el.audioTrackCount.textContent = tracks.length;
        this._renderAudioTrackList();
      } else {
        this.el.audioTrackWrap.classList.add('hidden');
        this._closeAudioMenu();
      }
    };

    tracks.addEventListener('addtrack', update);
    tracks.addEventListener('removetrack', update);
    update();
  },

  /** Reset audio UI when switching to a new channel. */
  _resetAudioTracks() {
    this.el.audioTrackWrap.classList.add('hidden');
    this.el.audioTrackCount.textContent = '';
    this._closeAudioMenu();
  },

  /** Build the track list items inside the popup. */
  _renderAudioTrackList() {
    let items = [];

    if (this.hls) {
      // HLS.js mode
      const tracks  = this.hls.audioTracks || [];
      const current = this.hls.audioTrack;
      items = tracks.map((t, i) => ({
        index:   i,
        label:   this._audioTrackLabel(t),
        active:  i === current,
      }));
    } else {
      // Native mode
      const tracks = this.el.video.audioTracks;
      if (!tracks) return;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        items.push({
          index:  i,
          label:  this._audioTrackLabel(t),
          active: t.enabled,
        });
      }
    }

    this.el.audioTrackList.innerHTML = items.map(item => `
      <button class="audio-track-item${item.active ? ' active' : ''}" data-index="${item.index}">
        <svg class="audio-track-check" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        ${this._esc(item.label)}
      </button>
    `).join('');

    this.el.audioTrackList.querySelectorAll('.audio-track-item').forEach(btn => {
      btn.addEventListener('click', () => {
        this._switchAudioTrack(parseInt(btn.dataset.index, 10));
        this._closeAudioMenu();
      });
    });
  },

  /** Switch to the given audio track index. */
  _switchAudioTrack(index) {
    if (this.hls) {
      this.hls.audioTrack = index;
    } else {
      const tracks = this.el.video.audioTracks;
      if (!tracks) return;
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].enabled = (i === index);
      }
      this._renderAudioTrackList();
    }

    // Show toast with track name
    const label = this.el.audioTrackList.querySelectorAll('.audio-track-item')[index]?.textContent?.trim();
    if (label) this.showToast('🎧 ' + label);
  },

  /** Build a human-readable label for an audio track. */
  _audioTrackLabel(track) {
    if (!track) return 'Track';
    const name = track.name || track.label || '';
    const lang = track.lang || track.language || '';
    if (name && lang && !name.toLowerCase().includes(lang.toLowerCase())) {
      return name + ' (' + lang.toUpperCase() + ')';
    }
    return name || lang.toUpperCase() || 'Track';
  },

  _updateNowPlaying(ch) {
    this.el.chBadgeTop.textContent  = 'CH ' + ch.number;
    this.el.nowPlayingName.textContent = ch.name;
    this.el.chBadge.textContent     = 'CH ' + ch.number;
    this.el.chNameBar.textContent   = ch.name;
    document.title = ch.name + ' — IPTV';
    this._setPlayIcon(false); // reset to pause icon (playing state)
  },

  showBuffering(show, msg = 'Buffering…') {
    this.el.buffering.classList.toggle('hidden', !show);
    if (show) this.el.bufferLabel.textContent = msg;
  },

  // ============================================================
  //  TV-Style Channel OSD (dial + next/prev banner)
  // ============================================================

  /**
   * Show the channel OSD with number and name.
   * @param {object} ch       - Channel object with .number and .name
   * @param {number} duration - How long to show it (ms). 0 = stay until manually hidden.
   */
  _osdTimer: null,

  showChannelOSD(ch, duration = 2500) {
    this.el.dialNumber.textContent = ch.number;
    this.el.dialName.textContent   = ch.name;
    this.el.channelDial.classList.remove('hidden');

    if (this._osdTimer) clearTimeout(this._osdTimer);
    if (duration > 0) {
      this._osdTimer = setTimeout(() => {
        this.el.channelDial.classList.add('hidden');
        this._osdTimer = null;
      }, duration);
    }
  },

  hideChannelOSD() {
    if (this._osdTimer) { clearTimeout(this._osdTimer); this._osdTimer = null; }
    this.el.channelDial.classList.add('hidden');
  },

  /**
   * Called on each digit keypress (0–9).
   * Accumulates digits up to the length of the highest channel number,
   * then navigates. Also navigates after 1.8s of silence.
   */
  startDial(digit) {
    // Max digits = number of digits in the highest channel number (minimum 4)
    const maxNum    = this.channels.reduce((m, c) => Math.max(m, c.number || 0), 0);
    const maxDigits = Math.max(4, String(maxNum).length);

    if (this.dialBuffer.length >= maxDigits) this.dialBuffer = '';
    this.dialBuffer += digit;

    // While dialing show only the number (no name yet — channel not confirmed)
    this.el.dialNumber.textContent = this.dialBuffer;
    this.el.dialName.textContent   = '';
    this.el.channelDial.classList.remove('hidden');

    if (this._osdTimer) clearTimeout(this._osdTimer);
    if (this.dialTimer) clearTimeout(this.dialTimer);

    // If we've reached max digits, commit immediately
    if (this.dialBuffer.length >= maxDigits) {
      this.dialTimer = setTimeout(() => this._commitDial(), 300);
    } else {
      this.dialTimer = setTimeout(() => this._commitDial(), 1800);
    }
  },

  _commitDial() {
    const num = parseInt(this.dialBuffer, 10);
    this.dialBuffer = '';
    this.dialTimer  = null;

    const ch = this.channels.find(c => c.number === num);
    if (ch) {
      this.playChannel(ch.index);
      // OSD with name will be shown by playChannel → showChannelOSD call inside nextChannel/prevChannel
      // but _commitDial goes directly to playChannel, so show it here
      this.showChannelOSD(ch, 2500);
    } else {
      this.el.dialNumber.textContent = num;
      this.el.dialName.textContent   = 'Not found';
      if (this._osdTimer) clearTimeout(this._osdTimer);
      this._osdTimer = setTimeout(() => this.el.channelDial.classList.add('hidden'), 1200);
      this.showToast('Channel ' + num + ' not found');
    }
  },

  // ============================================================
  //  Keyboard Navigation System
  //
  //  Two navigation zones:
  //    'controls' — the bottom button bar (←→ to move, Enter to activate)
  //    'channels' — the sidebar channel list (↑↓ to move, Enter to play)
  //
  //  Tab cycles between zones.
  //  Any hotkey action key exits navigation mode.
  //  Digit keys always go to channel dial regardless of zone.
  // ============================================================

  _navZone:       null,   // 'controls' | 'channels' | 'groups' | null
  _navCtrlIndex:  -1,     // index into _getCtrlButtons()
  _navChIndex:    -1,     // index into visible channel items
  _navGroupIndex: -1,     // index into group tab buttons
  _navZoneTimer:  null,

  _getCtrlButtons() {
    return Array.from(document.querySelectorAll('[data-nav="ctrl"]'))
      .sort((a, b) =>
        parseInt(a.dataset.navOrder || 99) - parseInt(b.dataset.navOrder || 99)
      );
  },

  _getVisibleChannelItems() {
    return Array.from(this.el.channelList.querySelectorAll('.channel-item'));
  },

  setupKeyboard() {
    document.addEventListener('keydown', e => {
      // Never intercept when typing in a form field
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      // Never intercept when settings modal is open (except Escape, handled there)
      if (!this.el.settingsModal.classList.contains('hidden')) return;

      // Digit keys → channel dial (always)
      if (e.key >= '0' && e.key <= '9' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        this._clearNavFocus();
        this.startDial(e.key);
        return;
      }

      // Arrow keys — navigation
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        this._showControls?.();
        this._handleArrowNav(e.key);
        return;
      }

      // Enter — activate focused element
      if (e.key === 'Enter') {
        if (this._navZone === 'controls' && this._navCtrlIndex >= 0) {
          e.preventDefault();
          this._getCtrlButtons()[this._navCtrlIndex]?.click();
          return;
        }
        if (this._navZone === 'groups' && this._navGroupIndex >= 0) {
          e.preventDefault();
          this._getGroupTabs()[this._navGroupIndex]?.click();
          return;
        }
        if (this._navZone === 'channels' && this._navChIndex >= 0) {
          e.preventDefault();
          const items = this._getVisibleChannelItems();
          items[this._navChIndex]?.click();
          return;
        }
        // Enter with no zone active — trigger play/pause
        e.preventDefault();
        this.togglePlayPause();
        return;
      }

      // Tab — cycle between zones
      if (e.key === 'Tab') {
        e.preventDefault();
        this._cycleNavZone(e.shiftKey);
        return;
      }

      // All other hotkey actions
      const action = Settings.getActionForKey(e.key);
      if (action) {
        e.preventDefault();
        this._clearNavFocus();
        this._executeAction(action);
      }
    });

    // Clicking anywhere on the player clears nav focus
    this.el.app.addEventListener('mousedown', () => this._clearNavFocus());
  },

  _sidebarVisible() {
    return !this.el.app.classList.contains('sidebar-hidden');
  },

  _handleArrowNav(key) {
    const sidebarOpen = this._sidebarVisible();

    // If no zone active, enter zone based on key direction
    if (!this._navZone) {
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        this._enterZone('controls', key === 'ArrowLeft' ? 'last' : 'first');
      } else if (key === 'ArrowDown') {
        this._enterZone(sidebarOpen ? 'groups' : 'controls');
      } else {
        this._enterZone(sidebarOpen ? 'channels' : 'controls', 'last');
      }
      return;
    }

    if (this._navZone === 'controls') {
      const btns = this._getCtrlButtons();
      if (!btns.length) return;
      if (key === 'ArrowLeft') {
        this._navCtrlIndex = (this._navCtrlIndex - 1 + btns.length) % btns.length;
        this._applyCtrlFocus();
      } else if (key === 'ArrowRight') {
        this._navCtrlIndex = (this._navCtrlIndex + 1) % btns.length;
        this._applyCtrlFocus();
      } else if (key === 'ArrowUp') {
        if (sidebarOpen) this._enterZone('channels');
        // if sidebar hidden, stay in controls — nothing above
      } else if (key === 'ArrowDown') {
        if (sidebarOpen) this._enterZone('groups');
        // if sidebar hidden, stay in controls — nothing below
      }
      return;
    }

    if (this._navZone === 'groups') {
      if (!sidebarOpen) { this._enterZone('controls'); return; }
      const tabs = this._getGroupTabs();
      if (!tabs.length) return;
      if (key === 'ArrowLeft') {
        this._navGroupIndex = (this._navGroupIndex - 1 + tabs.length) % tabs.length;
        this._applyGroupFocus();
      } else if (key === 'ArrowRight') {
        this._navGroupIndex = (this._navGroupIndex + 1) % tabs.length;
        this._applyGroupFocus();
      } else if (key === 'ArrowDown') {
        this._enterZone('channels', 'first');
      } else if (key === 'ArrowUp') {
        this._enterZone('controls', 'first');
      }
      return;
    }

    if (this._navZone === 'channels') {
      if (!sidebarOpen) { this._enterZone('controls'); return; }
      const items = this._getVisibleChannelItems();
      if (!items.length) return;
      if (key === 'ArrowUp') {
        if (this._navChIndex <= 0) {
          this._enterZone('groups');
          return;
        }
        this._navChIndex--;
        this._applyChFocus();
      } else if (key === 'ArrowDown') {
        if (this._navChIndex >= items.length - 1) {
          this._enterZone('controls', 'first');
          return;
        }
        this._navChIndex++;
        this._applyChFocus();
      } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        this._enterZone('controls', key === 'ArrowLeft' ? 'last' : 'first');
      }
      return;
    }
  },

  _getGroupTabs() {
    return Array.from(this.el.groupTabs.querySelectorAll('.group-tab'));
  },

  _enterZone(zone, startPos = 'first') {
    this._clearNavFocus();
    this._navZone = zone;

    if (zone === 'controls') {
      const btns = this._getCtrlButtons();
      this._navCtrlIndex = startPos === 'last' ? btns.length - 1 : 0;
      this._applyCtrlFocus();
      this._showNavHint('Controls');

    } else if (zone === 'groups') {
      const tabs = this._getGroupTabs();
      if (!tabs.length) { this._enterZone('channels', 'first'); return; }
      const activeIdx = tabs.findIndex(t => t.classList.contains('active'));
      this._navGroupIndex = activeIdx >= 0 ? activeIdx : 0;
      this._applyGroupFocus();
      this._showNavHint('Groups');

    } else { // channels
      const items = this._getVisibleChannelItems();
      if (!items.length) { this._navZone = null; return; }

      // Always start at the currently playing channel if it's visible,
      // otherwise fall back to top of the list
      const playingIdx = items.findIndex(el =>
        parseInt(el.dataset.index) === this.currentIndex
      );
      this._navChIndex = playingIdx >= 0 ? playingIdx : 0;

      this._applyChFocus();
      this._showNavHint('Channel List');
    }
  },

  _cycleNavZone(reverse = false) {
    const zones = ['controls', 'groups', 'channels'];
    if (!this._navZone) {
      this._enterZone(reverse ? zones[zones.length - 1] : zones[0]);
      return;
    }
    const idx  = zones.indexOf(this._navZone);
    const next = zones[(idx + (reverse ? -1 : 1) + zones.length) % zones.length];
    this._enterZone(next);
  },

  _applyCtrlFocus() {
    document.querySelectorAll('.ctrl-btn.kb-focus, .icon-btn.kb-focus').forEach(b => b.classList.remove('kb-focus'));
    const btns = this._getCtrlButtons();
    const btn  = btns[this._navCtrlIndex];
    if (btn) {
      btn.classList.add('kb-focus');
      btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    this._showNavHint('Controls');
  },

  _applyGroupFocus() {
    document.querySelectorAll('.group-tab.kb-focus').forEach(b => b.classList.remove('kb-focus'));
    const tabs = this._getGroupTabs();
    const tab  = tabs[this._navGroupIndex];
    if (tab) {
      tab.classList.add('kb-focus');
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    this._showNavHint('Groups');
  },

  _applyChFocus() {
    document.querySelectorAll('.channel-item.kb-focus').forEach(el => el.classList.remove('kb-focus'));
    const items = this._getVisibleChannelItems();
    const item  = items[this._navChIndex];
    if (item) {
      item.classList.add('kb-focus');
      // Use 'auto' (instant) — smooth queues up when keys are held and looks broken
      item.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    this._showNavHint('Channel List');
  },

  _clearNavFocus() {
    this._navZone       = null;
    this._navCtrlIndex  = -1;
    this._navChIndex    = -1;
    this._navGroupIndex = -1;
    document.querySelectorAll('.ctrl-btn.kb-focus, .icon-btn.kb-focus, .channel-item.kb-focus, .group-tab.kb-focus')
      .forEach(el => el.classList.remove('kb-focus'));
    this._hideNavHint();
  },

  _navHintTimer: null,
  _showNavHint(label) {
    this.el.navZoneHint.textContent = label;
    this.el.navZoneHint.classList.add('visible');
    if (this._navHintTimer) clearTimeout(this._navHintTimer);
    this._navHintTimer = setTimeout(() => this._hideNavHint(), 2000);
  },
  _hideNavHint() {
    this.el.navZoneHint.classList.remove('visible');
  },

  _executeAction(action) {
    switch (action) {
      case 'nextChannel':  this.nextChannel();       break;
      case 'prevChannel':  this.prevChannel();       break;
      case 'playPause':    this.togglePlayPause();   break;
      case 'stop':         this.stopPlayback();      break;
      case 'fullscreen':   this.toggleFullscreen();  break;
      case 'channelMenu':  this.toggleSidebar();     break;
      case 'mute':         this.toggleMute();        break;
      case 'volumeUp':     this.adjustVolume(+10);   break;
      case 'volumeDown':   this.adjustVolume(-10);   break;
    }
  },

  nextChannel() {
    if (!this.channels.length) return;
    const idx = (this.currentIndex + 1) % this.channels.length;
    this.playChannel(idx);
    this.showChannelOSD(this.channels[idx], 2500);
  },

  prevChannel() {
    if (!this.channels.length) return;
    const idx = (this.currentIndex - 1 + this.channels.length) % this.channels.length;
    this.playChannel(idx);
    this.showChannelOSD(this.channels[idx], 2500);
  },

  togglePlayPause() {
    const v = this.el.video;
    if (this.isStopped) {
      this.playChannel(this.currentIndex);
      return;
    }
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  },

  stopPlayback() {
    const v = this.el.video;
    v.pause();
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    v.src = '';
    this.isStopped = true;
    this.showBuffering(false);
    this._setPlayIcon(true);
  },

  toggleFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen).call(document);
    }
  },

  _requestFullscreen() {
    if (document.fullscreenElement) return; // already fullscreen
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
    if (fn) fn.call(el).catch(() => {}); // silently ignore if browser blocks it
  },

  toggleSidebar() {
    this.el.app.classList.toggle('sidebar-hidden');
  },

  toggleMute() {
    const v   = this.el.video;
    v.muted   = !v.muted;
    this.isMuted = v.muted;
    this._updateVolumeUI();
  },

  adjustVolume(delta) {
    const v     = this.el.video;
    v.volume    = Math.max(0, Math.min(1, v.volume + delta / 100));
    v.muted     = false;
    this.volume = v.volume;
    this.isMuted = false;
    this._updateVolumeUI();
  },

  _updateVolumeUI() {
    const v = this.el.video;
    const effectiveVol = v.muted ? 0 : v.volume;
    this.el.volumeSlider.value = effectiveVol * 100;

    // Swap volume icon
    const muted = effectiveVol === 0;
    this.el.volIcon.innerHTML = muted
      ? '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/>'
      : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  },

  _setPlayIcon(isPaused) {
    this.el.playIcon.innerHTML = isPaused
      ? '<path d="M8 5v14l11-7z"/>'                     // play triangle
      : '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'; // pause bars
  },

  // ============================================================
  //  Control Buttons Setup
  // ============================================================
  setupControlButtons() {
    this.el.prevBtn.addEventListener('click',       () => this.prevChannel());
    this.el.nextBtn.addEventListener('click',       () => this.nextChannel());
    this.el.playBtn.addEventListener('click',       () => this.togglePlayPause());
    this.el.stopBtn.addEventListener('click',       () => this.stopPlayback());
    this.el.muteBtn.addEventListener('click',       () => this.toggleMute());
    this.el.menuBtn.addEventListener('click',       () => this.toggleSidebar());
    this.el.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    this.el.settingsBtn.addEventListener('click',   () => this.openSettings());

    this.el.volumeSlider.addEventListener('input', () => {
      const v     = this.el.video;
      v.volume    = this.el.volumeSlider.value / 100;
      v.muted     = v.volume === 0;
      this.volume = v.volume;
      this.isMuted = v.muted;
      this._updateVolumeUI();
    });

    // Video element events
    const v = this.el.video;
    v.addEventListener('waiting',  () => this.showBuffering(true));
    v.addEventListener('stalled',  () => this.showBuffering(true, 'Stream stalled…'));
    v.addEventListener('canplay',  () => this.showBuffering(false));
    v.addEventListener('playing',  () => {
      this.showBuffering(false);
      this._setPlayIcon(false);
    });
    v.addEventListener('pause',    () => this._setPlayIcon(true));
    v.addEventListener('ended',    () => {
      // Auto-advance to next channel on stream end
      setTimeout(() => this.nextChannel(), 500);
    });

    // Fullscreen change (e.g. user presses Esc)
    document.addEventListener('fullscreenchange',       () => this._onFullscreenChange());
    document.addEventListener('webkitfullscreenchange', () => this._onFullscreenChange());
  },

  _sidebarBeforeFs: false, // was sidebar visible before entering fullscreen?

  _onFullscreenChange() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    this.el.app.classList.toggle('fullscreen', isFs);

    if (isFs) {
      // Remember current sidebar state then hide it
      this._sidebarBeforeFs = !this.el.app.classList.contains('sidebar-hidden');
      this.el.app.classList.add('sidebar-hidden');
    } else {
      // Restore sidebar to what it was before fullscreen
      this.el.app.classList.toggle('sidebar-hidden', !this._sidebarBeforeFs);
      // If we're back in channel nav zone but sidebar is now hidden, clear nav
      if (this._navZone === 'channels' || this._navZone === 'groups') {
        if (this.el.app.classList.contains('sidebar-hidden')) this._clearNavFocus();
      }
    }

    // Swap fullscreen icon
    this.el.fsIcon.innerHTML = isFs
      ? '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>'
      : '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>';
  },

  // ============================================================
  //  OSD Auto-Hide
  // ============================================================
  setupOSD() {
    const area = this.el.app;

    this._showControls = () => {
      this.el.topbar.classList.add('visible');
      this.el.controls.classList.add('visible');
      document.body.style.cursor = '';

      if (this.controlsTimer) clearTimeout(this.controlsTimer);

      // Only auto-hide when in fullscreen
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        this.controlsTimer = setTimeout(() => {
          this.el.topbar.classList.remove('visible');
          this.el.controls.classList.remove('visible');
          document.body.style.cursor = 'none';
        }, 3000);
      }
    };

    area.addEventListener('mousemove',  this._showControls);
    area.addEventListener('click',      this._showControls);
    area.addEventListener('touchstart', this._showControls, { passive: true });

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        // Just entered fullscreen — start the hide timer
        this._showControls();
      } else {
        // Exited fullscreen — show controls permanently (no timer)
        if (this.controlsTimer) clearTimeout(this.controlsTimer);
        this.el.topbar.classList.add('visible');
        this.el.controls.classList.add('visible');
        document.body.style.cursor = '';
      }
    });

    // Show by default
    this._showControls();
  },

  // ============================================================
  //  Settings Modal
  // ============================================================
  setupSettingsModal() {
    // Tab switching
    document.querySelectorAll('.mtab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.mtab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    this.el.modalClose.addEventListener('click',    () => this.closeSettings());
    this.el.modalBackdrop.addEventListener('click', () => this.closeSettings());

    this.el.applyUrlBtn.addEventListener('click', () => {
      const url1 = this.el.settingsUrl.value.trim();
      const url2 = this.el.settingsUrl2.value.trim();
      if (!url1) return;
      Settings.m3uUrls = [url1, url2];
      Settings.save();
      this.closeSettings();
      this.loadAllPlaylists();
    });

    this.el.uploadM3u.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        this.closeSettings();
        this.loadAllPlaylists({ texts: [ev.target.result] });
      };
      reader.readAsText(file);
    });

    this.el.bufferMode.addEventListener('change', () => {
      Settings.bufferMode = this.el.bufferMode.value;
      Settings.save();
    });

    this.el.resetHotkeys.addEventListener('click', () => {
      Settings.resetHotkeys();
      this.renderHotkeyList();
      this.showToast('Hotkeys reset to defaults');
    });

    // ---- Custom Channels ----
    this.el.cchAddBtn.addEventListener('click', () => {
      const name   = this.el.cchName.value.trim();
      const url    = this.el.cchUrl.value.trim();
      const group  = this.el.cchGroup.value.trim() || 'Custom';
      const logo   = this.el.cchLogo.value.trim();
      const numRaw = this.el.cchNumber.value.trim();
      const num    = numRaw ? parseInt(numRaw, 10) : null;

      if (!name) { this._cchError('Please enter a channel name.'); return; }
      if (!url)  { this._cchError('Please enter a stream URL.'); return; }
      if (num !== null && (isNaN(num) || num < 1)) {
        this._cchError('Channel number must be a positive integer.'); return;
      }

      if (this._editingId) {
        // ---- Save edit ----
        const idx = Settings.customChannels.findIndex(c => c.id === this._editingId);
        if (idx >= 0) {
          Settings.customChannels[idx] = {
            ...Settings.customChannels[idx],
            name, url, group, logo, number: num,
          };
          Settings.save();
        }
        this._cancelEditMode();
      } else {
        // ---- Add new ----
        const newCh = { id: 'custom_' + Date.now(), name, url, group, logo, number: num };
        Settings.customChannels.push(newCh);
        Settings.save();
        this.showToast(name + ' added');
      }

      this.el.cchName.value   = '';
      this.el.cchUrl.value    = '';
      this.el.cchGroup.value  = '';
      this.el.cchLogo.value   = '';
      this.el.cchNumber.value = '';
      this.el.cchError.classList.add('hidden');

      this._rebuildChannels();
      this.renderCustomChannelsList();
    });

    // Cancel edit button
    this.el.cchCancelBtn.addEventListener('click', () => {
      this._cancelEditMode();
      this.el.cchName.value   = '';
      this.el.cchUrl.value    = '';
      this.el.cchGroup.value  = '';
      this.el.cchLogo.value   = '';
      this.el.cchNumber.value = '';
      this.el.cchError.classList.add('hidden');
    });

    // Enter key submits from URL field
    this.el.cchUrl.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.el.cchAddBtn.click();
    });

    // ---- Settings modal keyboard navigation ----
    document.addEventListener('keydown', e => {
      if (this.el.settingsModal.classList.contains('hidden')) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSettings();
        return;
      }

      // ←/→ switch tabs
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const tabs  = Array.from(document.querySelectorAll('.mtab'));
        const cur   = tabs.findIndex(t => t.classList.contains('active'));
        const next  = (cur + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        e.preventDefault();
        tabs[next].click();
        return;
      }

      // ↑/↓ move between focusable elements inside modal (including header buttons and tabs)
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const focusable = Array.from(
          document.querySelectorAll(
            '#modal-close, .mtab, .tab-pane.active input, .tab-pane.active select, ' +
            '.tab-pane.active button:not(.hidden), .tab-pane.active .key-badge, ' +
            '.tab-pane.active .cch-play-btn, .tab-pane.active .cch-edit-btn, .tab-pane.active .cch-delete-btn'
          )
        ).filter(el => !el.disabled && el.offsetParent !== null);
        if (!focusable.length) return;
        e.preventDefault();
        const cur  = focusable.indexOf(document.activeElement);
        const next = (cur + (e.key === 'ArrowDown' ? 1 : -1) + focusable.length) % focusable.length;
        focusable[next].focus();
        return;
      }

      // Enter activates the focused element (buttons already fire on Enter natively,
      // but we handle it here to avoid double-fire on non-button elements)
      if (e.key === 'Enter' && document.activeElement?.tagName === 'BUTTON') {
        // Let the native button click handle it
        return;
      }
    });
  },

  renderCustomChannelsList() {
    const list = Settings.customChannels;
    if (!list.length) {
      this.el.customChList.innerHTML = '';
      return;
    }

    this.el.customChList.innerHTML = list.map((cc, i) => {
      const logo = cc.logo
        ? `<img class="cch-logo" src="${this._esc(cc.logo)}" alt="" onerror="this.style.display='none'" />`
        : `<div class="cch-logo-placeholder">▶</div>`;
      const numTag = cc.number ? `<span class="cch-num-tag">CH ${cc.number}</span>` : '';
      return `
        <div class="cch-item" data-id="${this._esc(cc.id)}">
          ${logo}
          <div class="cch-info">
            <div class="cch-name">${this._esc(cc.name)}</div>
            <div class="cch-group">${numTag}${this._esc(cc.group || 'Custom')}</div>
          </div>
          <button class="cch-play-btn" title="Play now">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <button class="cch-edit-btn" title="Edit">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
          <button class="cch-delete-btn" title="Delete">✕</button>
        </div>
      `;
    }).join('');

    // Play button
    this.el.customChList.querySelectorAll('.cch-play-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.cch-item').dataset.id;
        const cc = Settings.customChannels.find(c => c.id === id);
        if (!cc) return;
        const ch = this.channels.find(c => c.url === cc.url);
        if (ch) { this.closeSettings(); this.playChannel(ch.index); }
      });
    });

    // Edit button — populate form and switch to edit mode
    this.el.customChList.querySelectorAll('.cch-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.cch-item').dataset.id;
        this._beginEditChannel(id);
      });
    });

    // Delete button
    this.el.customChList.querySelectorAll('.cch-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id   = btn.closest('.cch-item').dataset.id;
        const idx  = Settings.customChannels.findIndex(c => c.id === id);
        const name = Settings.customChannels[idx]?.name || 'Channel';
        if (this._editingId === id) this._cancelEditMode();
        Settings.customChannels.splice(idx, 1);
        Settings.save();
        this._rebuildChannels();
        this.renderCustomChannelsList();
        this.showToast(name + ' removed');
      });
    });
  },

  _cchError(msg) {
    this.el.cchError.textContent = msg;
    this.el.cchError.classList.remove('hidden');
  },

  _beginEditChannel(id) {
    const cc = Settings.customChannels.find(c => c.id === id);
    if (!cc) return;
    this._editingId = id;

    // Populate form
    this.el.cchName.value   = cc.name;
    this.el.cchUrl.value    = cc.url;
    this.el.cchGroup.value  = cc.group !== 'Custom' ? cc.group : '';
    this.el.cchLogo.value   = cc.logo || '';
    this.el.cchNumber.value = cc.number || '';
    this.el.cchError.classList.add('hidden');

    // Swap button labels
    this.el.cchAddBtn.textContent    = '✓ Save Changes';
    this.el.cchCancelBtn.classList.remove('hidden');

    // Highlight the item being edited
    this.el.customChList.querySelectorAll('.cch-item').forEach(el => {
      el.classList.toggle('editing', el.dataset.id === id);
    });

    // Scroll form into view
    this.el.cchName.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    this.el.cchName.focus();
  },

  _cancelEditMode() {
    this._editingId = null;
    this.el.cchAddBtn.textContent = '+ Add Channel';
    this.el.cchCancelBtn.classList.add('hidden');
    this.el.customChList.querySelectorAll('.cch-item').forEach(el => {
      el.classList.remove('editing');
    });
  },

  /** Rebuild this.channels from cached playlist channels + custom channels, re-render list. */
  _rebuildChannels() {
    const prevCh = this.currentIndex >= 0 ? this.channels[this.currentIndex] : null;
    this.channels = this._mergeCustomChannels(this.playlistChannels);
    // Try to keep the same channel selected
    if (prevCh) {
      const newIdx = this.channels.findIndex(c => c.url === prevCh.url);
      if (newIdx >= 0) this.currentIndex = newIdx;
    }
    this.renderChannelList();
  },

  openSettings() {
    this.el.settingsUrl.value  = Settings.m3uUrls[0] || '';
    this.el.settingsUrl2.value = Settings.m3uUrls[1] || '';
    this.el.bufferMode.value   = Settings.bufferMode;
    this.renderHotkeyList();
    this.renderCustomChannelsList();
    this.el.cchError.classList.add('hidden');
    this.el.settingsModal.classList.remove('hidden');

    // Live stats update
    this._updateStats();
    this.statsInterval = setInterval(() => this._updateStats(), 1000);
  },

  closeSettings() {
    this.el.settingsModal.classList.add('hidden');
    if (this.statsInterval) { clearInterval(this.statsInterval); this.statsInterval = null; }
    this._cancelKeyCapture();
    this._cancelEditMode();
  },

  _updateStats() {
    this.el.statSpeed.textContent = this.networkMonitor.getSpeedLabel();

    const v = this.el.video;
    if (v.buffered.length > 0 && !isNaN(v.currentTime)) {
      const ahead = v.buffered.end(v.buffered.length - 1) - v.currentTime;
      this.el.statBuffer.textContent = ahead.toFixed(1) + 's';
    } else {
      this.el.statBuffer.textContent = '—';
    }

    if (this.hls) {
      const level = this.hls.levels?.[this.hls.currentLevel];
      if (level) {
        this.el.statQuality.textContent = level.height
          ? level.height + 'p'
          : Math.round(level.bitrate / 1000) + ' Kbps';
      } else {
        this.el.statQuality.textContent = 'Auto';
      }
    } else {
      this.el.statQuality.textContent = v.src ? 'Native' : '—';
    }

    const vq = v.getVideoPlaybackQuality?.();
    this.el.statDropped.textContent = vq ? vq.droppedVideoFrames : '—';
  },

  // ============================================================
  //  Hotkey Table
  // ============================================================
  _captureTarget:  null,
  _captureHandler: null,

  renderHotkeyList() {
    this._cancelKeyCapture();
    this.el.hotkeyList.innerHTML = Object.entries(Settings.hotkeys).map(([action, binding]) => `
      <div class="hotkey-row">
        <span class="hk-label">${this._esc(binding.label)}</span>
        <button class="key-badge" data-action="${action}">${formatKeyLabel(binding.key)}</button>
      </div>
    `).join('');

    this.el.hotkeyList.querySelectorAll('.key-badge').forEach(btn => {
      btn.addEventListener('click', () => this._startKeyCapture(btn.dataset.action, btn));
    });
  },

  _startKeyCapture(action, btn) {
    this._cancelKeyCapture();

    this._captureTarget = action;
    btn.classList.add('listening');
    btn.textContent = '…';

    const handler = e => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        this._cancelKeyCapture();
        return;
      }

      // Digits 0–9 are reserved for channel dial
      if (e.key >= '0' && e.key <= '9') {
        btn.textContent = 'Digits reserved';
        btn.classList.remove('listening');
        setTimeout(() => {
          btn.textContent = formatKeyLabel(Settings.hotkeys[action].key);
        }, 1400);
        this._captureTarget  = null;
        this._captureHandler = null;
        document.removeEventListener('keydown', handler, true);
        return;
      }

      Settings.hotkeys[action].key = e.key;
      Settings.save();
      btn.classList.remove('listening');
      btn.textContent = formatKeyLabel(e.key);
      this._captureTarget  = null;
      this._captureHandler = null;
      document.removeEventListener('keydown', handler, true);
    };

    this._captureHandler = handler;
    document.addEventListener('keydown', handler, true);
  },

  _cancelKeyCapture() {
    if (this._captureHandler) {
      document.removeEventListener('keydown', this._captureHandler, true);
    }
    if (this._captureTarget) {
      const btn = this.el.hotkeyList.querySelector(`[data-action="${this._captureTarget}"]`);
      if (btn) {
        btn.classList.remove('listening');
        btn.textContent = formatKeyLabel(Settings.hotkeys[this._captureTarget]?.key || '');
      }
    }
    this._captureTarget  = null;
    this._captureHandler = null;
  },

  // ============================================================
  //  Toast Notification
  // ============================================================
  _toastTimer: null,

  showToast(msg, duration = 2500) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.remove('hidden');
    requestAnimationFrame(() => t.classList.add('show'));
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.classList.add('hidden'), 250);
    }, duration);
  },

  // ============================================================
  //  Utility
  // ============================================================
  _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};

// ============================================================
//  Boot
// ============================================================
document.addEventListener('DOMContentLoaded', () => App.init());
