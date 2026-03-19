/**
 * m3u-parser.js
 * Parses standard M3U / IPTV extended M3U playlists.
 * Returns an array of channel objects.
 */

'use strict';

/**
 * Extract a named attribute value from an EXTINF line.
 * Handles both quoted and unquoted values.
 */
function extractAttr(line, name) {
  // Try quoted value: name="value"
  const quotedRe = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i');
  const quotedMatch = line.match(quotedRe);
  if (quotedMatch) return quotedMatch[1].trim();

  // Try unquoted value: name=value (space or comma terminated)
  const unquotedRe = new RegExp(name + '\\s*=\\s*([^\\s,"]+)', 'i');
  const unquotedMatch = line.match(unquotedRe);
  if (unquotedMatch) return unquotedMatch[1].trim();

  return '';
}

/**
 * Parse an M3U text string into an array of channel objects.
 *
 * @param {string} text - Raw M3U file content
 * @returns {Array<{number, name, logo, id, group, url}>}
 */
function parseM3U(text) {
  // Normalise line endings
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const channels = [];
  let pending = null;
  let channelNumber = 1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) continue;

    // Header line — skip
    if (line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF')) {
      // ---- Parse metadata line ----
      // Format: #EXTINF:<duration> [attributes...],<Display Name>

      // Channel display name is everything after the last comma
      let name = '';
      const commaIdx = line.lastIndexOf(',');
      if (commaIdx !== -1) {
        name = line.substring(commaIdx + 1).trim();
      }
      if (!name) name = 'Channel ' + channelNumber;

      // tvg-chno overrides auto-numbering if present
      const tvgChno = extractAttr(line, 'tvg-chno');
      const num = tvgChno ? parseInt(tvgChno, 10) || channelNumber : channelNumber;

      pending = {
        number: num,
        name:   name,
        logo:   extractAttr(line, 'tvg-logo'),
        id:     extractAttr(line, 'tvg-id'),
        group:  extractAttr(line, 'group-title') || 'Uncategorized',
        url:    '',
      };

      channelNumber++;

    } else if (line.startsWith('#EXTVLCOPT') || line.startsWith('#EXTGRP')) {
      // Known non-URL comment lines — skip

    } else if (!line.startsWith('#')) {
      // This should be a stream URL
      if (pending) {
        pending.url = line;
        channels.push(pending);
        pending = null;
      } else {
        // URL without preceding EXTINF — create a bare entry
        channels.push({
          number: channelNumber++,
          name:   'Channel ' + channelNumber,
          logo:   '',
          id:     '',
          group:  'Uncategorized',
          url:    line,
        });
      }
    }
  }

  // Re-number sequentially (some playlists have duplicates)
  channels.forEach((ch, i) => { ch.index = i; });

  return channels;
}
