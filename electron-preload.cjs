/* global process */ // sandboxed preload: argv/env come from the limited process object
// Preload: exposes the per-launch token to the page BEFORE any page script runs
// (the bootstrap race: app.js fires its first API calls during parse, so a
// dom-ready-time injection would always lose). The token comes from the shell via
// additionalArguments — sandboxed preloads can read argv but not the full env.
const { contextBridge } = require('electron');
// env first (the main process exports PIWB_TOKEN for the renderer); argv stays as a legacy fallback
const arg = (process.argv || []).find((a) => a && a.startsWith && a.startsWith('--piwb-token='));
const token = arg ? arg.slice('--piwb-token='.length) : (process.env.PIWB_TOKEN || null);
try {
  contextBridge.exposeInMainWorld('__PIWB_TOKEN', token || null);
} catch { /* context unavailable — page falls back to embedded mode */ }
