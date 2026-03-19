/**
 * settings.js
 * Manages all persistent settings: M3U URL, hotkeys, buffer mode.
 * Saves to / loads from localStorage.
 */

'use strict';

// ============================================================
// Default hotkey bindings
// Keys are KeyboardEvent.key values.
// ============================================================
const DEFAULT_HOTKEYS = {
  nextChannel:  { key: 'ArrowUp',    label: 'Next Channel' },
  prevChannel:  { key: 'ArrowDown',  label: 'Previous Channel' },
  playPause:    { key: ' ',          label: 'Play / Pause' },
  stop:         { key: 's',          label: 'Stop' },
  fullscreen:   { key: 'f',          label: 'Fullscreen' },
  channelMenu:  { key: 'c',          label: 'Toggle Channel List' },
  mute:         { key: 'm',          label: 'Mute / Unmute' },
  volumeUp:     { key: 'ArrowRight', label: 'Volume Up (+10%)' },
  volumeDown:   { key: 'ArrowLeft',  label: 'Volume Down (−10%)' },
};

const STORAGE_KEY = 'iptv_player_settings_v3';

const Settings = {
  /** @type {Object<string,{key:string,label:string}>} */
  hotkeys:       {},
  bufferMode:    'auto',
  m3uUrls:       ['', ''],
  /** @type {Array<{id,name,url,group,logo}>} */
  customChannels: [],

  /** Load from localStorage, falling back to defaults. */
  load() {
    const raw    = localStorage.getItem(STORAGE_KEY);
    const oldRaw = !raw ? localStorage.getItem('iptv_player_settings_v2') : null;
    if (!raw && !oldRaw) { this._applyDefaults(); return; }
    try {
      const data = JSON.parse(raw || oldRaw);
      this.hotkeys = {};
      for (const [action, def] of Object.entries(DEFAULT_HOTKEYS)) {
        this.hotkeys[action] = {
          label: def.label,
          key:   data.hotkeys?.[action]?.key ?? def.key,
        };
      }
      this.bufferMode     = data.bufferMode     || 'auto';
      this.customChannels = data.customChannels || [];
      // Migrate old single m3uUrl → m3uUrls[0]
      if (Array.isArray(data.m3uUrls)) {
        this.m3uUrls = [data.m3uUrls[0] || '', data.m3uUrls[1] || ''];
      } else {
        this.m3uUrls = [data.m3uUrl || '', ''];
      }
    } catch (e) {
      this._applyDefaults();
    }
  },

  /** Persist current settings. */
  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      hotkeys:        this.hotkeys,
      bufferMode:     this.bufferMode,
      m3uUrls:        this.m3uUrls,
      customChannels: this.customChannels,
    }));
  },

  /** True if at least one URL slot is filled. */
  hasAnyUrl() {
    return this.m3uUrls.some(u => u.trim() !== '');
  },

  /** Reset hotkeys to defaults and save. */
  resetHotkeys() {
    this._applyDefaults();
    this.save();
  },

  /** Given a key string, return the matching action name (or null). */
  getActionForKey(key) {
    for (const [action, binding] of Object.entries(this.hotkeys)) {
      if (binding.key === key) return action;
    }
    return null;
  },

  _applyDefaults() {
    this.hotkeys = {};
    for (const [action, def] of Object.entries(DEFAULT_HOTKEYS)) {
      this.hotkeys[action] = { key: def.key, label: def.label };
    }
  },
};

/**
 * Human-readable label for a key value.
 * @param {string} key
 * @returns {string}
 */
function formatKeyLabel(key) {
  const map = {
    ' ':          'Space',
    'ArrowUp':    '↑',
    'ArrowDown':  '↓',
    'ArrowLeft':  '←',
    'ArrowRight': '→',
    'Enter':      'Enter',
    'Escape':     'Esc',
    'Backspace':  '⌫',
    'Delete':     'Del',
    'Tab':        'Tab',
    'PageUp':     'PgUp',
    'PageDown':   'PgDn',
    'Home':       'Home',
    'End':        'End',
    'Insert':     'Ins',
  };
  if (map[key]) return map[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}
