/**
 * Precision Infrastructure Console (`GET /dashboard`).
 * Monochrome Geist/Linear engineering aesthetic:
 *  - Overview, Real-Time Request Logs (with Account Filter & Chat-Block Drawer),
 *  - Credentials & Quotas, Model Access Control (Single & Batch Enable/Disable),
 *  - Routing & Sticky Affinity, and Live Playground.
 */
export function renderDashboardHtml(dashboardPath = "/dashboard", nonce = ""): string {
  const serializedDashPath = JSON.stringify(dashboardPath).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='2' y='2' width='60' height='60' rx='15' fill='%23F4F4F5' stroke='%23D4D4D8' stroke-width='2.5'/%3E%3Cpath d='M32 12L49 22V42L32 52L15 42V22Z' fill='none' stroke='%2318181B' stroke-width='4' stroke-linejoin='round'/%3E%3Cpath d='M16 37L29.5 29V35.5L48 25' fill='none' stroke='%2318181B' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" />
  <title>aws-quick-admin</title>
  <style>
    :root[data-theme="dark"] {
      --bg: #0a0a0b;
      --panel: #111113;
      --panel-hover: #18181b;
      --subtle: #161619;
      --border: #242429;
      --border-strong: #34343c;
      --fg: #f4f4f5;
      --fg-muted: #a1a1aa;
      --fg-faint: #8e8e98;
      --cta-bg: #f4f4f5;
      --cta-fg: #09090b;
      --cta-hover: #dcdce0;
      --ok: #10b981;
      --warn: #f59e0b;
      --err: #ef4444;
      --track: #222227;
    }
    :root[data-theme="light"] {
      --bg: #fafafa;
      --panel: #ffffff;
      --panel-hover: #f4f4f5;
      --subtle: #f4f4f5;
      --border: #e4e4e7;
      --border-strong: #d4d4d8;
      --fg: #09090b;
      --fg-muted: #52525b;
      --fg-faint: #71717a;
      --cta-bg: #18181b;
      --cta-fg: #ffffff;
      --cta-hover: #27272a;
      --ok: #059669;
      --warn: #d97706;
      --err: #dc2626;
      --track: #e4e4e7;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "PingFang SC", sans-serif;
      background: var(--bg);
      color: var(--fg);
      font-size: 13px;
      line-height: 1.5;
      font-variant-numeric: tabular-nums;
      -webkit-font-smoothing: antialiased;
    }
    .mono {
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }

    input, select, textarea {
      font: inherit;
      font-size: 12.5px;
      color: var(--fg);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 10px;
      transition: border-color 0.12s;
    }
    input:not([type="checkbox"]), select { height: 32px; }
    select {
      appearance: none; -webkit-appearance: none;
      padding-right: 28px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 9px center;
      cursor: pointer;
    }
    select:hover { border-color: var(--border-strong); }
    .c-sel-wrap { position: relative; display: inline-flex; align-items: center; }
    .c-sel-native { position: absolute !important; inset: 0; opacity: 0; pointer-events: none; width: 100%; height: 100%; }
    .c-sel-trigger {
      height: 32px; width: 100%; padding: 0 28px 0 10px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
      font: inherit; font-size: 12.5px; font-weight: 400;
      display: inline-flex; align-items: center; justify-content: flex-start; gap: 6px;
      cursor: pointer; white-space: nowrap; text-align: left;
      transition: border-color 0.12s, background-color 0.12s;
    }
    .c-sel-trigger:hover { border-color: var(--border-strong); background: var(--panel-hover); }
    .c-sel-trigger.open { border-color: var(--fg-muted); }
    .c-sel-trigger-lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .c-sel-chev {
      position: absolute; right: 9px; top: 50%; transform: translateY(-50%);
      width: 12px; height: 12px; color: var(--fg-muted); pointer-events: none; transition: transform 0.14s ease;
    }
    .c-sel-trigger.open + .c-sel-chev { transform: translateY(-50%) rotate(180deg); }
    .c-sel-menu {
      position: fixed; z-index: 120; display: none;
      background: var(--panel); color: var(--fg); border: 1px solid var(--border-strong);
      border-radius: 8px; padding: 4px; min-width: 170px; max-height: 280px; overflow-y: auto;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
    }
    .c-sel-menu.open { display: block; }
    .c-sel-opt {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      width: 100%; padding: 6px 9px; border-radius: 5px; border: none; background: transparent;
      color: var(--fg); font: inherit; font-size: 12.5px; font-weight: 400; text-align: left; cursor: pointer;
    }
    .c-sel-opt:hover { background: var(--panel-hover); }
    .c-sel-opt.active { background: var(--subtle); font-weight: 500; }
    .c-sel-chk { width: 13px; height: 13px; flex-shrink: 0; color: var(--ok); opacity: 0; }
    .c-sel-opt.active .c-sel-chk { opacity: 1; }
    input[type="checkbox"] { width: 15px; height: 15px; padding: 0; cursor: pointer; accent-color: var(--cta-bg); }
    input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, .clickable-row:focus-visible {
      outline: 2px solid var(--fg-muted);
      outline-offset: 2px;
    }
    .switch input:focus-visible + .slider {
      outline: 2px solid var(--fg-muted);
      outline-offset: 2px;
    }
    button {
      font: inherit;
      font-size: 12.5px;
      font-weight: 500;
      height: 32px;
      color: var(--fg);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: background-color 0.12s, border-color 0.12s;
      white-space: nowrap;
    }
    button:hover { background: var(--panel-hover); border-color: var(--border-strong); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-solid {
      background: var(--cta-bg);
      color: var(--cta-fg);
      border-color: var(--cta-bg);
    }
    .btn-solid:hover { background: var(--cta-hover); border-color: var(--cta-hover); }
    .btn-ghost { background: transparent; border-color: transparent; color: var(--fg-muted); padding: 5px 8px; }
    .btn-ghost:hover { background: var(--panel-hover); color: var(--fg); border-color: transparent; }
    .btn-danger { color: var(--err); }
    .btn-danger:hover { border-color: var(--err); background: rgba(239,68,68,0.06); }
    .btn-xs { height: 24px; padding: 0 8px; font-size: 11.5px; border-radius: 4px; white-space: nowrap; }

    /* Login Gate */
    #loginGate {
      min-height: 100vh;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .login-box {
      width: 100%;
      max-width: 360px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 28px 24px;
    }
    .login-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .login-mark {
      width: 24px; height: 24px; border: 1px solid var(--border-strong);
      border-radius: 5px; display: flex; align-items: center; justify-content: center;
    }
    .login-head h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
    .login-desc { color: var(--fg-muted); font-size: 12px; margin-bottom: 20px; }
    .login-form { display: flex; flex-direction: column; gap: 12px; }
    .login-form input { width: 100%; padding: 8px 11px; }
    .login-form button { width: 100%; padding: 8px 12px; font-size: 13px; }
    .login-err { color: var(--err); font-size: 12px; min-height: 18px; }

    /* App Shell */
    #appShell {
      display: none;
      min-height: 100vh;
      min-width: 0;
      max-width: 100%;
      grid-template-columns: 220px minmax(0, 1fr);
    }
    @media (max-width: 860px) {
      #appShell { grid-template-columns: 1fr; }
      aside { position: static !important; height: auto !important; border-right: none !important; border-bottom: 1px solid var(--border); }
    }

    aside {
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      background: var(--panel);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      padding: 16px 12px;
    }
    .brand-row {
      display: flex; align-items: center; gap: 7px;
      padding: 4px 6px 16px; border-bottom: 1px solid var(--border); margin-bottom: 12px;
    }
    .brand-title { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; }
    .brand-ver { font-size: 10.5px; color: var(--fg-muted); margin-left: auto; flex-shrink: 0; }

    .nav-list { display: flex; flex-direction: column; gap: 2px; }
    .nav-item {
      width: 100%; justify-content: flex-start; border: 1px solid transparent; background: transparent;
      color: var(--fg-muted); padding: 7px 10px; border-radius: 6px; font-size: 13px; font-weight: 500;
    }
    .nav-item:hover { background: var(--panel-hover); color: var(--fg); border-color: transparent; }
    .nav-item.active { background: var(--subtle); color: var(--fg); border-color: var(--border); }
    .nav-item svg { width: 15px; height: 15px; stroke-width: 1.7; flex-shrink: 0; }
    .nav-count {
      margin-left: auto; font-size: 11px; color: var(--fg-muted);
      background: var(--bg); border: 1px solid var(--border); border-radius: 99px; padding: 0 6px;
    }

    .aside-foot {
      border-top: 1px solid var(--border); padding-top: 12px;
      display: flex; align-items: center; justify-content: space-between; gap: 4px; flex-wrap: wrap;
    }

    .main-col { display: flex; flex-direction: column; min-width: 0; }
    .topbar {
      position: sticky; top: 0; z-index: 20;
      height: 56px; border-bottom: 1px solid var(--border); background: var(--panel);
      padding: 0 24px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    }
    .topbar-left { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 14px; }
    .topbar-right { display: flex; align-items: center; gap: 4px; }
    .sync-time { font-size: 12px; color: var(--fg-muted); margin-right: 8px; }
    .tb-icon-btn {
      display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 2px; min-width: 48px; height: 42px; padding: 4px 8px;
      border-radius: 6px; border: 1px solid transparent; background: transparent;
      color: var(--fg-muted); cursor: pointer; transition: background-color 0.15s, color 0.15s, border-color 0.15s;
    }
    .tb-icon-btn:hover { background: var(--panel-hover); color: var(--fg); border-color: var(--border); }
    .tb-icon-btn svg { width: 15px; height: 15px; stroke-width: 1.8; flex-shrink: 0; }
    .tb-lbl { font-size: 10.5px; line-height: 1.1; white-space: nowrap; }

    .workspace { padding: 24px; max-width: 1360px; width: 100%; min-width: 0; overflow-x: clip; }
    .view-pane { display: none; min-width: 0; }
    .view-pane.active { display: block; min-width: 0; max-width: 100%; }

    .onboard-banner {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      padding: 14px 18px;
      margin-bottom: 18px;
      background: var(--panel);
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    }
    .onboard-banner.show { display: flex; }
    .onboard-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .onboard-steps { font-size: 12px; color: var(--fg-muted); line-height: 1.6; }
    .onboard-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

    /* Segmented 1px Metric Strip */
    .metric-strip {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      background: var(--border);
      gap: 1px;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 18px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    }
    @media (max-width: 900px) { .metric-strip { grid-template-columns: repeat(2, 1fr); } }
    .metric-cell { background: var(--panel); padding: 15px 18px; }
    .metric-k { font-size: 12px; color: var(--fg-muted); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
    .metric-v { font-size: 23px; font-weight: 600; letter-spacing: -0.025em; line-height: 1.2; font-variant-numeric: tabular-nums; }
    .metric-s { font-size: 11.5px; color: var(--fg-muted); margin-top: 6px; font-variant-numeric: tabular-nums; }

    /* Overview charts (inline SVG, no external libs) */
    .ov-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .seg button { height: 30px; padding: 0 12px; font-size: 12px; border: none; border-radius: 0; background: var(--panel); color: var(--fg-muted); }
    .seg button + button { border-left: 1px solid var(--border); }
    .seg button.active { background: var(--cta-bg); color: var(--cta-fg); }
    .seg-sm button { height: 24px; padding: 0 9px; font-size: 11.5px; }
    .ov-note { font-size: 12px; color: var(--fg-muted); }
    .ov-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: stretch; }
    @media (max-width: 900px) { .ov-grid { grid-template-columns: 1fr; } }
    .ov-grid > .panel-box { display: flex; flex-direction: column; }
    .ov-chart { position: relative; flex: 1; padding: 16px 18px; min-height: 210px; display: flex; align-items: center; }
    #ovTrend svg { width: 100%; height: auto; display: block; overflow: visible; }
    #ovDonut svg { flex-shrink: 0; display: block; overflow: visible; }
    .ov-empty { width: 100%; color: var(--fg-muted); font-size: 12px; text-align: center; padding: 52px 0; }
    .ov-donut-wrap { width: 100%; display: flex; align-items: center; gap: 24px; }
    @media (max-width: 560px) { .ov-donut-wrap { flex-direction: column; } }
    .ov-donut-arc { cursor: pointer; transition: stroke-width 0.16s ease, opacity 0.16s ease; }
    .ov-donut-legend { flex: 1; min-width: 0; font-size: 12px; display: grid; gap: 4px; font-variant-numeric: tabular-nums; }
    .ov-dl-row {
      display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto; align-items: center; gap: 8px;
      padding: 5px 8px; border-radius: 6px; cursor: pointer; transition: background-color 0.12s ease, opacity 0.16s ease;
    }
    .ov-dl-row:hover, .ov-dl-row.is-hot { background: var(--panel-hover); }
    .ov-dl-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .ov-dl-req { color: var(--fg-muted); text-align: right; white-space: nowrap; font-size: 11.5px; }
    .ov-dl-tok { color: var(--fg); text-align: right; white-space: nowrap; min-width: 96px; font-weight: 500; }
    .ov-tip {
      position: fixed; z-index: 90; pointer-events: none; opacity: 0;
      background: var(--panel); color: var(--fg); border: 1px solid var(--border-strong);
      border-radius: 8px; padding: 8px 11px; font-size: 11.5px; line-height: 1.45;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14); transition: opacity 0.1s ease;
      font-variant-numeric: tabular-nums; min-width: 150px; max-width: 280px;
    }
    .ov-tip.show { opacity: 1; }
    .ov-tip-hdr { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
    .ov-tip-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .ov-tip-k { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-muted); }
    .ov-sw { width: 9px; height: 9px; border-radius: 2px; flex: none; }
    .ov-legend { font-size: 11.5px; color: var(--fg-muted); display: inline-flex; gap: 14px; align-items: center; }
    .ov-rank { padding: 12px 16px 16px; display: grid; gap: 11px; font-variant-numeric: tabular-nums; }
    .ov-rank-row { display: grid; grid-template-columns: minmax(100px, 170px) 1fr auto; gap: 12px; align-items: center; font-size: 12px; }
    .ov-rank-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .ov-track { height: 7px; background: var(--subtle); border: 1px solid var(--border); border-radius: 99px; overflow: hidden; }
    .ov-fill { height: 100%; background: var(--ok); border-radius: 99px; transition: width 0.25s ease; }

    /* Panels & Tables */
    .panel-box {
      position: relative;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 18px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
      min-width: 0;
      max-width: 100%;
    }
    .panel-box.is-loading::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      height: 1.5px;
      width: 34%;
      background: var(--fg);
      opacity: 0.72;
      z-index: 4;
      animation: panelProgressSlide 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    @keyframes panelProgressSlide {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(390%); }
    }
    @keyframes quickSpin {
      to { transform: rotate(360deg); }
    }
    .inline-spin {
      display: inline-block;
      width: 11px;
      height: 11px;
      border: 1.5px solid var(--border-strong);
      border-top-color: var(--fg);
      border-radius: 50%;
      vertical-align: -1.5px;
      flex-shrink: 0;
      animation: quickSpin 0.7s linear infinite;
    }
    tbody tr.row-busy td {
      background: color-mix(in srgb, var(--subtle) 85%, var(--fg) 3%);
    }
    @media (prefers-reduced-motion: reduce) {
      .panel-box.is-loading::before, .inline-spin { animation: none; }
    }
    .panel-hdr {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    }
    .panel-hdr h2 { font-size: 13px; font-weight: 600; }
    .panel-hdr p { font-size: 12px; color: var(--fg-muted); }

    .batch-bar {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--subtle);
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    }

    .table-wrap {
      overflow-x: auto;
      overflow-y: hidden;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain;
    }
    table {
      width: max-content;
      min-width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 12.5px;
    }
    th {
      text-align: left; padding: 9px 11px; font-size: 11px; font-weight: 500;
      color: var(--fg-muted); background: var(--subtle); border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    td {
      padding: 10px 11px; border-bottom: 1px solid var(--border); vertical-align: middle;
      white-space: nowrap; background: var(--panel);
    }
    tr:last-child td { border-bottom: none; }
    tr.row-disabled td:not(.ops-cell) { opacity: 0.52; }
    tr.clickable-row { cursor: pointer; transition: background-color 0.1s; }
    tr.clickable-row:hover td, tr:hover td { background: var(--panel-hover); }
    tr.row-picked td { background: var(--subtle); }
    th.ops-cell, td.ops-cell {
      position: sticky;
      right: 0;
      z-index: 3;
      background: var(--panel);
      border-left: 1px solid var(--border);
      box-shadow: -8px 0 12px -8px rgba(0, 0, 0, 0.18);
    }
    :root[data-theme="dark"] th.ops-cell, :root[data-theme="dark"] td.ops-cell {
      box-shadow: -8px 0 12px -8px rgba(0, 0, 0, 0.55);
    }
    th.ops-cell { z-index: 4; background: var(--subtle); }
    tr:hover td.ops-cell, tr.clickable-row:hover td.ops-cell { background: var(--panel-hover); }
    tr.row-picked td.ops-cell { background: var(--subtle); }
    .ops-stack { display: flex; flex-wrap: nowrap; gap: 4px; width: max-content; }
    .ops-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, max-content)); gap: 4px; width: max-content; }
    .bill-cell, .run-cell { white-space: normal; max-width: 220px; }
    .bill-cell > div, .run-cell > div { white-space: normal; }

    .status-line { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }
    .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .dot-ok { background: var(--ok); }
    .dot-warn { background: var(--warn); }
    .dot-err { background: var(--err); }
    .dot-off { background: var(--fg-faint); }
    @keyframes pulseOp { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .dot-pulse { background: var(--warn); animation: pulseOp 1.2s infinite; }

    .tag {
      display: inline-block; white-space: nowrap; padding: 2px 7px; font-size: 11px; font-weight: 500;
      border: 1px solid var(--border); border-radius: 4px; color: var(--fg-muted);
      background: var(--subtle);
    }
    .tag-ok { color: var(--ok); border-color: rgba(16,185,129,0.35); }
    .tag-info { color: #1d4ed8; background: #eff6ff; border-color: rgba(59,130,246,0.32); }
    [data-theme="dark"] .tag-info { color: #93c5fd; background: rgba(59,130,246,0.16); border-color: rgba(96,165,250,0.32); }
    .tag-warn { color: var(--warn); border-color: rgba(245,158,11,0.35); }

    .qbar-cell { width: 128px; min-width: 128px; max-width: 128px; }
    .qbar-top { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; font-size: 11.5px; margin-bottom: 4px; min-width: 0; }
    .qbar-rem { color: var(--fg-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .qbar-track { height: 5px; background: var(--track); border-radius: 2px; overflow: hidden; }
    .qbar-fill { height: 100%; border-radius: 2px; transition: width 0.25s ease; }
    .bot-stack { width: 128px; max-width: 128px; white-space: normal; }

    .setting-row {
      display: flex; align-items: center; justify-content: space-between; gap: 20px;
      padding: 16px 18px; border-bottom: 1px solid var(--border);
    }
    .setting-row:last-child { border-bottom: none; }
    .setting-info h3 { font-size: 13px; font-weight: 500; margin-bottom: 2px; }
    .setting-info p { font-size: 12px; color: var(--fg-muted); max-width: 640px; }

    .switch { position: relative; display: inline-block; width: 34px; height: 19px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; cursor: pointer; inset: 0; background: var(--track);
      border: 1px solid var(--border-strong); border-radius: 99px; transition: 0.15s;
    }
    .slider:before {
      content: ""; position: absolute; height: 13px; width: 13px; left: 2px; bottom: 2px;
      background: var(--fg-muted); border-radius: 50%; transition: 0.15s;
    }
    input:checked + .slider { background: var(--cta-bg); border-color: var(--cta-bg); }
    input:checked + .slider:before { transform: translateX(15px); background: var(--cta-fg); }

    /* Modal */
    .modal-mask {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55);
      display: none; align-items: center; justify-content: center; padding: 20px; z-index: 60;
    }
    .modal-mask.open { display: flex; }
    .modal-card {
      width: 100%; max-width: 460px; max-height: 90vh; background: var(--panel);
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
      display: flex; flex-direction: column;
    }
    .modal-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; flex: 1; }
    .modal-foot {
      padding: 12px 16px; border-top: 1px solid var(--border); background: var(--subtle);
      display: flex; justify-content: flex-end; gap: 8px; flex-shrink: 0;
    }
    .ag-list { display: flex; flex-direction: column; gap: 10px; max-height: 300px; overflow-y: auto; }
    .ag-item {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
      padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px;
      background: var(--bg); cursor: pointer; text-align: left; width: 100%;
      height: auto; white-space: normal;
      transition: border-color 0.12s, background-color 0.12s;
    }
    .ag-item:hover { border-color: var(--border-strong); background: var(--panel-hover); }
    .ag-item.active { border-color: var(--cta-bg); background: var(--subtle); cursor: default; }
    .ag-pill {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; font-weight: 500; padding: 2px 7px; border-radius: 99px;
      border: 1px solid var(--border); color: var(--fg-muted); background: var(--panel);
      white-space: nowrap;
    }
    .ag-pill.ok { border-color: transparent; background: rgba(16,185,129,0.14); color: var(--ok); }
    .ag-adv { border-top: 1px solid var(--border); padding-top: 10px; }
    .ag-adv summary { cursor: pointer; font-size: 12px; color: var(--fg-muted); user-select: none; }
    .ag-adv summary:hover { color: var(--fg); }
    .routed-pill {
      margin-left: 5px;
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11.5px; font-weight: 500;
      white-space: nowrap;
    }
    :root[data-theme="light"] .routed-opus { color: #6d28d9; }
    :root[data-theme="dark"] .routed-opus { color: #a78bfa; }
    :root[data-theme="light"] .routed-sonnet { color: #2563eb; }
    :root[data-theme="dark"] .routed-sonnet { color: #60a5fa; }
    :root[data-theme="light"] .routed-haiku { color: #059669; }
    :root[data-theme="dark"] .routed-haiku { color: #34d399; }
    :root[data-theme="light"] .routed-other { color: #b45309; }
    :root[data-theme="dark"] .routed-other { color: #fbbf24; }
    .ck-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      padding: 10px 12px;
      max-height: 290px;
      overflow-y: auto;
      align-content: start;
      background: var(--bg);
    }
    @media (max-width: 640px) { .ck-grid { grid-template-columns: 1fr; } }
    .ck-card {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px 10px;
      min-height: 44px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel);
      cursor: pointer;
      min-width: 0;
      transition: border-color 0.12s, background-color 0.12s;
    }
    .ck-card:hover { background: var(--panel-hover); border-color: var(--border-strong); }
    .ck-card.picked { border-color: var(--fg); background: var(--subtle); }
    .ck-card-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .ck-card-id { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ck-card-name { font-size: 11px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preset-pills { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 5px; }
    .field-lbl { font-size: 12px; color: var(--fg-muted); display: block; margin-bottom: 4px; }

    pre.code-block {
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 12px 14px; overflow-x: auto; font-size: 12px; line-height: 1.55; color: var(--fg);
      white-space: pre-wrap; word-break: break-word;
    }

    /* Slide-Over Request Trace Drawer */
    .drawer-mask {
      position: fixed; inset: 0; background: rgba(0,0,0,0.45);
      display: none; justify-content: flex-end; z-index: 55;
    }
    .drawer-mask.open { display: flex; }
    .drawer-panel {
      width: 100%; max-width: 720px; height: 100%; background: var(--panel);
      border-left: 1px solid var(--border); display: flex; flex-direction: column;
    }
    .drawer-hdr {
      padding: 14px 18px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
    }
    .drawer-body { padding: 18px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 14px; }
    .kv-grid {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;
      padding: 12px 14px; background: var(--subtle); border: 1px solid var(--border); border-radius: 6px;
    }
    .kv-item span { display: block; font-size: 11px; color: var(--fg-muted); }
    .kv-item strong { font-size: 12.5px; font-weight: 600; }

    /* Top-right floating Toast stack (Sonner monochrome style) */
    .toast-stack {
      position: fixed; top: 16px; right: 20px; z-index: 9999;
      display: flex; flex-direction: column; gap: 8px; max-width: 360px; pointer-events: none;
    }
    .toast-item {
      pointer-events: auto; display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; border-radius: 8px; font-size: 12.5px; line-height: 1.45;
      background: var(--panel); color: var(--fg); border: 1px solid var(--border);
      box-shadow: 0 8px 24px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.04); animation: toastIn 0.18s ease-out;
    }
    .toast-icon { width: 15px; height: 15px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--fg); }
    .toast-item.err .toast-icon { color: var(--err); }
    .toast-close { margin-left: auto; border: none; background: transparent; color: var(--fg-muted); cursor: pointer; padding: 2px 4px; font-size: 12px; }
    .toast-close:hover { color: var(--fg); }
    @keyframes toastIn { from { opacity: 0; transform: translateY(-8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

    /* Add Credential modal: segmented tabs & 2-step wizard */
    .seg-tabs {
      display: flex; gap: 3px; padding: 3px;
      background: var(--subtle); border: 1px solid var(--border); border-radius: 8px;
    }
    .seg-tab {
      flex: 1; border: none; background: transparent; color: var(--fg-muted);
      font-size: 12px; font-weight: 500; padding: 6px 8px; border-radius: 6px;
      cursor: pointer; transition: color 0.15s, background 0.15s, box-shadow 0.15s;
    }
    .seg-tab:hover { color: var(--fg); }
    .seg-tab.active {
      background: var(--panel); color: var(--fg);
      box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    }
    .oauth-stepper { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--fg-muted); }
    .oauth-step-pill {
      display: inline-flex; align-items: center; gap: 6px; font-weight: 500;
      border: none; background: transparent; padding: 2px 4px; border-radius: 5px;
      color: inherit; font: inherit; cursor: default;
    }
    .oauth-step-pill.active, .oauth-step-pill.done { color: var(--fg); }
    .oauth-step-pill.done { cursor: pointer; }
    .oauth-step-pill.done:hover { background: var(--subtle); }
    .oauth-step-num {
      width: 18px; height: 18px; border-radius: 999px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 600;
      background: var(--subtle); color: var(--fg-muted); border: 1px solid var(--border);
    }
    .oauth-step-pill.active .oauth-step-num,
    .oauth-step-pill.done .oauth-step-num {
      background: var(--fg); color: var(--panel); border-color: var(--fg);
    }
    .oauth-step-line { flex: 1; height: 1px; background: var(--border); transition: background 0.2s; }
    .oauth-step-line.done { background: var(--fg); }
    .oauth-card {
      display: flex; flex-direction: column; gap: 10px; padding: 14px;
      background: var(--subtle); border: 1px solid var(--border); border-radius: 8px;
    }
    .oauth-card-step2 {
      background: var(--panel); border: 1.5px solid var(--fg);
      animation: oauthStepIn 0.2s cubic-bezier(0.22, 1, 0.36, 1);
    }
    @keyframes oauthStepIn {
      from { opacity: 0; transform: translateX(10px); }
      to { opacity: 1; transform: translateX(0); }
    }
    .oauth-step-kicker {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 12px; font-weight: 600; color: var(--fg);
    }
    .oauth-step-tag {
      font-size: 11px; font-weight: 500; color: var(--fg-muted);
      background: var(--subtle); border: 1px solid var(--border);
      padding: 1px 7px; border-radius: 999px;
    }
    .oauth-done-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 8px 12px; background: var(--subtle); border: 1px solid var(--border);
      border-radius: 7px; font-size: 12px; color: var(--fg);
    }
    .more-opt-details > summary {
      cursor: pointer; font-size: 12px; color: var(--fg-muted); user-select: none;
      padding: 2px 0; transition: color 0.15s;
    }
    .more-opt-details > summary:hover { color: var(--fg); }
    .more-opt-inner {
      display: flex; flex-direction: column; gap: 10px; margin-top: 10px;
      padding: 12px; background: var(--subtle); border: 1px solid var(--border); border-radius: 8px;
    }
  </style>
</head>
<body>

  <!-- 1. Password Login Gate -->
  <div id="loginGate">
    <div class="login-box">
      <div class="login-head" style="justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="login-mark" style="background:none;border:none;padding:0;width:28px;height:28px;">
            <svg width="28" height="28" viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="15" fill="#F4F4F5" stroke="#D4D4D8" stroke-width="2.5"/><path d="M32 12L49 22V42L32 52L15 42V22Z" fill="none" stroke="#18181B" stroke-width="4" stroke-linejoin="round"/><path d="M16 37L29.5 29V35.5L48 25" fill="none" stroke="#18181B" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <h1 id="loginGateTitle">aws-quick-admin</h1>
        </div>
        <button type="button" class="btn-xs btn-ghost" id="loginLangBtn">EN</button>
      </div>
      <p class="login-desc" id="loginGateDesc">输入管理员访问密码以解锁多账号调度、模型权限、实时日志与额度中心。</p>
      <form class="login-form" id="loginForm">
        <input id="loginPwdInput" type="password" placeholder="管理员密码" autocomplete="current-password" required />
        <input id="loginPwdConfirmInput" type="password" placeholder="再次确认管理员密码（至少 8 位）" autocomplete="new-password" style="display:none;" />
        <div class="login-err" id="loginErrText"></div>
        <button type="submit" class="btn-solid" id="loginSubmitBtn">验证并进入控制台</button>
      </form>
    </div>
  </div>

  <!-- 2. Main Console -->
  <div id="appShell">
    <aside>
      <div>
        <div class="brand-row">
          <svg width="22" height="22" style="flex-shrink:0;" viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="15" fill="#F4F4F5" stroke="#D4D4D8" stroke-width="2.5"/><path d="M32 12L49 22V42L32 52L15 42V22Z" fill="none" stroke="#18181B" stroke-width="4" stroke-linejoin="round"/><path d="M16 37L29.5 29V35.5L48 25" fill="none" stroke="#18181B" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="brand-title">aws-quick-admin</span>
          <span class="brand-ver mono" id="sidebarBrandVer">v0.1.0</span>
        </div>
        <nav class="nav-list">
          <button class="nav-item active" data-tab="overview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>
            总览监控
          </button>
          <button class="nav-item" data-tab="credentials">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
            凭证与额度池
          </button>
          <button class="nav-item" data-tab="clientkeys">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            网关子密钥管理
            <span class="nav-count mono" id="navClientKeyCount">1</span>
          </button>
          <button class="nav-item" data-tab="models">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            模型权限管理
            <span class="nav-count mono" id="navModelCount">—</span>
          </button>
          <button class="nav-item" data-tab="routing">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            路由与亲和策略
          </button>
          <button class="nav-item" data-tab="logs">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            实时请求日志
            <span class="nav-count mono" id="navLogCount">0</span>
          </button>
        </nav>
      </div>
    </aside>

    <div class="main-col">
      <div class="topbar">
        <div class="topbar-left" id="topbarTitle">总览监控</div>
        <div class="topbar-right">
          <button class="tb-icon-btn" id="versionPillBtn" type="button" style="display:none;font-size:11.5px;padding:4px 8px;" title="Version Info"></button>
          <span class="sync-time mono" id="syncTimeLabel">—</span>
          <button class="tb-icon-btn" id="langToggleBtn" type="button" title="切换语言">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
            <span class="tb-lbl">中文</span>
          </button>
          <button class="tb-icon-btn" id="themeToggleBtn" type="button" title="切换主题">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41"/></svg>
            <span class="tb-lbl">浅色</span>
          </button>
          <button class="tb-icon-btn" id="changePwdBtn" type="button" title="修改管理员密码">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <span class="tb-lbl">改密</span>
          </button>
          <button class="tb-icon-btn" id="logoutBtn" type="button" title="退出登录">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            <span class="tb-lbl">退出</span>
          </button>
        </div>
      </div>

      <div class="workspace">

        <!-- TAB 1: OVERVIEW -->
        <div class="view-pane active" id="pane-overview">
          <div class="onboard-banner" id="onboardBanner">
            <div>
              <div class="onboard-title" id="onboardTitle">2 步快速开始使用</div>
              <div class="onboard-steps" id="onboardSteps">
                ① 点击右侧「+ 添加凭证」通过网页授权（90天自动续期）或 Cookie 导入账号。<br/>
                ② 在 AI 客户端填入接口地址与 <span class="mono">GATEWAY_TOKEN</span>（或「网关子密钥管理」中自动生成的默认 <span class="mono">sk-aq-...</span> 密钥）即可直接调用，无需重复建密钥。
              </div>
            </div>
            <div class="onboard-actions">
              <button class="btn-solid" data-open-add-modal>+ 添加凭证</button>
              <button type="button" id="onboardToKeysBtn">查看调用密钥 →</button>
            </div>
          </div>

          <div class="ov-bar">
            <div class="seg" id="ovRangeSeg">
              <button class="active" data-click="setOvRange" data-arg="today">今天</button>
              <button data-click="setOvRange" data-arg="7d">近 7 天</button>
              <button data-click="setOvRange" data-arg="30d">近 30 天</button>
            </div>
            <span class="ov-note" id="ovNote">统计仅记录模型、子密钥、客户端 IP、账号与 token 数，不保存任何对话内容</span>
          </div>

          <div class="metric-strip">
            <div class="metric-cell">
              <div class="metric-k"><span>请求数</span><span class="mono" id="ovErrTag">错误 0</span></div>
              <div class="metric-v" id="ovReq">0</div>
              <div class="metric-s" id="ovReqSub">成功率 —</div>
            </div>
            <div class="metric-cell">
              <div class="metric-k"><span>Token 总量</span></div>
              <div class="metric-v" id="ovTok">0</div>
              <div class="metric-s" id="ovTokSub">输入 0 · 缓存 0 · 输出 0</div>
            </div>
            <div class="metric-cell">
              <div class="metric-k"><span>缓存命中率</span></div>
              <div class="metric-v" id="ovCache">0%</div>
              <div class="metric-s" id="ovCacheSub">缓存读取占输入侧比例</div>
            </div>
            <div class="metric-cell">
              <div class="metric-k"><span>可用账号</span><span class="mono" id="mStrategyTag">quota-aware</span></div>
              <div class="metric-v" id="mActiveKeys">0 / 0</div>
              <div class="metric-s" id="mInflightSub">活跃并发流: 0 · 自动熔断: 0</div>
            </div>
          </div>

          <div class="ov-grid">
            <div class="panel-box">
              <div class="panel-hdr">
                <h2 id="ovDistTitle">模型分布（按 Token）</h2>
                <div class="seg seg-sm" id="ovDistSeg">
                  <button class="active" data-click="setOvDist" data-arg="model">请求模型</button>
                  <button data-click="setOvDist" data-arg="routed">实际路由</button>
                  <button data-click="setOvDist" data-arg="account">按账号</button>
                  <button data-click="setOvDist" data-arg="key">按子密钥</button>
                </div>
              </div>
              <div class="ov-chart" id="ovDonut"></div>
            </div>
            <div class="panel-box">
              <div class="panel-hdr"><h2>Token 趋势</h2><span class="ov-legend" id="ovTrendLegend"></span></div>
              <div class="ov-chart" id="ovTrend"></div>
            </div>
          </div>

          <div class="panel-box">
            <div class="panel-hdr">
              <div>
                <h2>账号池实时额度速览</h2>
                <p>点击任意账号行可直接跳转查看该账号的专属实时请求日志</p>
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button data-sync-quota>同步最新额度</button>
                <button type="button" id="ovManageCredsBtn">管理凭证 →</button>
                <button class="btn-solid" data-open-add-modal>+ 添加凭证</button>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>账号信息</th>
                    <th style="min-width:175px;">额度余量</th>
                    <th>运行与调度</th>
                  </tr>
                </thead>
                <tbody id="overviewAccountsBody"></tbody>
              </table>
            </div>
          </div>

          <div class="panel-box">
            <div class="panel-hdr">
              <div><h2>最近请求</h2><p id="ovRecentSub">仅元数据，默认展示最近 10 条（不保存任何对话内容）</p></div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                <select id="ovFilterIp" data-change="renderOvRecent"><option value="">全部 IP</option></select>
                <select id="ovFilterKey" data-change="renderOvRecent"><option value="">全部子密钥</option></select>
                <select id="ovFilterClient" data-change="renderOvRecent"><option value="">全部客户端</option></select>
                <button id="ovViewAllLogsBtn" type="button">查看全部日志 →</button>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>状态</th>
                    <th>模型 / 实际路由</th>
                    <th>执行账号 / 模式</th>
                    <th>子密钥</th>
                    <th>客户端 / IP</th>
                    <th>首包 / 总耗时</th>
                    <th>输入 / 缓存 / 输出</th>
                  </tr>
                </thead>
                <tbody id="ovRecentBody"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- TAB 2: REAL-TIME REQUEST LOGS -->
        <div class="view-pane" id="pane-logs">
          <div class="panel-box">
            <div class="panel-hdr">
              <div>
                <h2>实时请求日志（仅元数据，点击任意行查看复用诊断）</h2>
                <p>网关不保存对话内容，仅记录模型、账号、耗时、Token 与单向指纹</p>
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <select id="logAccountFilter" style="min-width:165px;">
                  <option value="all">全部执行账号</option>
                </select>
                <select id="logFilterSelect">
                  <option value="all">全部请求类型</option>
                  <option value="running">生成中</option>
                  <option value="tools">含工具调用</option>
                  <option value="thinking">含思考链</option>
                  <option value="error">异常报错</option>
                </select>
                <input id="logSearchInput" type="text" placeholder="搜模型 / 客户端 / UA..." style="width:185px;" />
                <button id="livePollLogsBtn">实时刷新(3s): 开</button>
                <button id="manualRefreshLogsBtn">刷新</button>
                <button class="btn-danger" id="clearLogsBtn">清空</button>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>状态</th>
                    <th>模型 / 协议</th>
                    <th>执行账号 / 模式</th>
                    <th>输出与上下文规模</th>
                    <th>首包 / 总耗时</th>
                    <th>新发 / 缓存 / 输出</th>
                  </tr>
                </thead>
                <tbody id="logsTableBody"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- TAB 3: CREDENTIALS -->
        <div class="view-pane" id="pane-credentials">
          <div class="panel-box" id="credPanelBox">
            <div class="panel-hdr">
              <div>
                <h2>AWS Quick 凭证管理</h2>
                <p>支持网页 OAuth 授权（90天自动续期）、Cookie 导入、独立出口代理与云端会话一键清理</p>
              </div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <button id="credSyncQuotaBtn" data-sync-quota>同步最新额度</button>
                <button class="btn-solid" data-open-add-modal>+ 添加凭证</button>
              </div>
            </div>
            <div class="batch-bar">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <input id="credSearchInput" type="text" placeholder="搜邮箱 / 备注 / 代理..." style="width:185px;" />
                <select id="credStatusFilter">
                  <option value="all">全部状态</option>
                  <option value="healthy">正常在线</option>
                  <option value="abnormal">异常 / 耗尽 / 冷却</option>
                  <option value="disabled">已停用</option>
                </select>
                <select id="credSortFilter">
                  <option value="newest">最新导入优先</option>
                  <option value="oldest">最早导入优先</option>
                  <option value="quota">剩余额度最多</option>
                  <option value="requests">调度次数最多</option>
                </select>
                <span style="font-size:12px;color:var(--fg-muted);" id="credSelSummary">已选 0 项</span>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button type="button" id="credBatchRecheckBtn">批量检测</button>
                <button type="button" id="credClearSessionsBtn">清理会话</button>
                <button type="button" id="credBatchImportBtn">导入 JSON</button>
                <input type="file" id="credBatchImportFile" accept=".json,application/json" style="display:none;" />
                <button type="button" id="credExportBtn">导出 JSON</button>
                <button type="button" id="credBatchEnableBtn">批量启用</button>
                <button type="button" id="credBatchDisableBtn">批量停用</button>
                <button type="button" class="btn-danger" id="credBatchDeleteBtn">批量删除</button>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:36px;"><input type="checkbox" id="credSelectAllCb" title="全选当前筛选列表" /></th>
                    <th style="width:52px;">启用</th>
                    <th>账号信息</th>
                    <th style="min-width:170px;">额度余量</th>
                    <th style="min-width:110px;">导入时间</th>
                    <th style="min-width:175px;">运行状态</th>
                    <th class="ops-cell">操作</th>
                  </tr>
                </thead>
                <tbody id="credTableBody"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- TAB 3b: CLIENT GATEWAY SUB-KEYS -->
        <div class="view-pane" id="pane-clientkeys">
          <div class="panel-box">
            <div class="panel-hdr">
              <div>
                <h2>网关对外调用密钥管理 (Client Gateway Sub-Keys)</h2>
                <p>支持创建多把网关子密钥分发给不同客户端或同事，每把密钥可独立勾选允许访问的模型白名单并统计用量</p>
              </div>
              <button class="btn-solid" id="openCreateCkModalBtn">+ 创建网关子密钥</button>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:65px;">启用</th>
                    <th>密钥名称</th>
                    <th>Token (点击安全复制)</th>
                    <th>可访问模型范围</th>
                    <th>次数限制 / 有效期</th>
                    <th>累计 Token / 最近调用</th>
                    <th class="ops-cell">操作</th>
                  </tr>
                </thead>
                <tbody id="clientKeysBody"></tbody>
              </table>
            </div>
          </div>

          <div class="panel-box" id="ckConnectPanel">
            <div class="panel-hdr">
              <div>
                <h2 id="ckConnectTitle">快捷接入、分享与在线测试</h2>
                <p id="ckConnectSubtitle">点击上方任意子密钥的「接入」按钮（或点击 Token），自动填入真实接口地址与 API Key，可直接复制发给他人或在线测一下</p>
              </div>
              <div class="seg seg-sm" id="ckConnectSeg">
                <button type="button" class="active" data-click="setCkConnectTab" data-arg="share">一键分享</button>
                <button type="button" data-click="setCkConnectTab" data-arg="openai">OpenAI 接入</button>
                <button type="button" data-click="setCkConnectTab" data-arg="anthropic">Anthropic / Claude</button>
                <button type="button" data-click="setCkConnectTab" data-arg="test">在线测试</button>
              </div>
            </div>
            <div style="padding:16px;">
              <div id="ckPaneShare" style="display:flex;flex-direction:column;gap:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                  <span class="field-lbl" style="margin:0;">直接复制以下配置发给同事或填入任意 AI 客户端（Claude Code / Cherry Studio / Cline / NextChat）</span>
                  <button type="button" class="btn-solid btn-xs" id="copyShareSnippetBtn">一键复制分享</button>
                </div>
                <pre class="code-block mono" id="snippetShare">加载中...</pre>
              </div>
              <div id="ckPaneOpenai" style="display:none;flex-direction:column;gap:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                  <span class="field-lbl" style="margin:0;">OpenAI 兼容协议接入示例（含真实地址与当前选中子密钥）</span>
                  <button type="button" class="btn-xs" id="copyOpenaiSnippetBtn">复制代码</button>
                </div>
                <pre class="code-block mono" id="snippetOpenai">加载中...</pre>
              </div>
              <div id="ckPaneAnthropic" style="display:none;flex-direction:column;gap:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                  <span class="field-lbl" style="margin:0;">Anthropic Claude 原生协议接入示例（Claude Code CLI / @ai-sdk/anthropic）</span>
                  <button type="button" class="btn-xs" id="copyClaudeSnippetBtn">复制代码</button>
                </div>
                <pre class="code-block mono" id="snippetClaude">加载中...</pre>
              </div>
              <div id="ckPaneTest" style="display:none;flex-direction:column;gap:12px;">
                <div style="display:flex;gap:10px;flex-wrap:wrap;">
                  <select id="pgModel" style="min-width:240px;" class="mono">
                    <option value="claude-haiku-5-5">claude-haiku-5-5</option>
                    <option value="claude-sonnet-5-5" selected>claude-sonnet-5-5</option>
                    <option value="claude-opus-5-5">claude-opus-5-5</option>
                  </select>
                  <input id="pgPrompt" type="text" value="请先思考一下：为什么 0.1 + 0.2 在浮点数里不等于 0.3？用一句话总结。" style="flex:1;min-width:240px;" />
                  <button type="button" class="btn-solid" id="pgSendBtn">发送测试</button>
                </div>
                <pre class="code-block mono" id="pgOutput" style="min-height:96px;">点击「发送测试」查看实时返回结果与实际路由模型...</pre>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 4: MODEL ACCESS CONTROL -->
        <div class="view-pane" id="pane-models">
          <div class="panel-box">
            <div class="panel-hdr">
              <div>
                <h2>对外开放模型列表与启停管理 (Model Access Control)</h2>
                <p>参数传法：① 模型名后缀如 <span class="mono">claude-sonnet-5-5[effort=high]</span>、<span class="mono">claude-opus-5-5[effort=max]</span>；② 标准请求体 <span class="mono">reasoning_effort</span> / Claude <span class="mono">thinking</span>（网关会自动映射为 AWS Quick 的 <span class="mono">agent_mode</span> 与 <span class="mono">thinking_effort</span>）。档位：<span class="mono">off/low/medium/high/max</span>，<span class="mono">max</span> 透传后按账号探测，上游不支持时自动降级为 <span class="mono">high</span>（可用 <span class="mono">THINKING_EFFORT_MAX_PASSTHROUGH=false</span> 全局关闭）</p>
              </div>
              <button id="refreshModelsBtn">刷新上游模型目录</button>
            </div>
            <div class="batch-bar">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <input id="modelSearchInput" type="text" placeholder="搜索模型 ID 或名称..." style="width:240px;" />
                <span style="font-size:12px;color:var(--fg-muted);" id="modelSelSummary">已勾选 0 项</span>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button id="batchEnableBtn">批量启用勾选</button>
                <button id="batchDisableBtn">批量禁用勾选</button>
                <button id="batchWhitelistBtn" title="仅保留当前勾选的模型启用，其余全部禁用">仅启用勾选项(白名单)</button>
                <button id="batchEnableAllBtn">全部恢复启用</button>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style="width:36px;"><input type="checkbox" id="modelSelectAllCb" title="全选当前筛选列表" /></th>
                    <th style="width:70px;">对外状态</th>
                    <th>模型 ID (Model ID)</th>
                    <th>显示名称</th>
                    <th>模型定位</th>
                    <th>支持调节参数</th>
                  </tr>
                </thead>
                <tbody id="modelsManageBody">
                  <tr><td colspan="6" style="text-align:center;color:var(--fg-muted);padding:24px;">点击左侧菜单自动加载实时模型目录...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- TAB 5: ROUTING & AFFINITY -->
        <div class="view-pane" id="pane-routing">
          <div class="panel-box">
            <div class="panel-hdr">
              <div>
                <h2>多账号调度、亲和性与熔断策略</h2>
                <p>修改后立即生效并自动持久化写回服务器 .env</p>
              </div>
              <button class="btn-solid" id="saveRoutingBtn">保存路由配置</button>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <h3>负载均衡算法 (Load Balancing Strategy)</h3>
                <p>Quota-Aware 会综合检测账号剩余月度额度与短时限额，优先分配给余量充足且当前并发最少的健康账号。</p>
              </div>
              <select id="cfgLbStrategy" style="min-width: 240px;">
                <option value="quota-aware">Quota-Aware (余量感知 + 最少并发)</option>
                <option value="least-busy">Least-Busy (最少活跃并发优先)</option>
                <option value="round-robin">Round-Robin (均匀轮询)</option>
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <h3>会话粘性亲和 (Sticky Session Affinity)</h3>
                <p>开启后，同一对话窗口在有效期内始终锁定同一健康账号执行，防止跨号跳跃；若原账号耗尽或限流则自动漂移至健康账号。</p>
              </div>
              <div style="display:flex;align-items:center;gap:12px;">
                <span style="font-size:12px;color:var(--fg-muted);">TTL(秒):</span>
                <input id="cfgAffinityTtl" type="number" min="60" max="86400" style="width:90px;" class="mono" />
                <label class="switch"><input type="checkbox" id="cfgAffinityEnabled" /><span class="slider"></span></label>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <h3>额度耗尽 / 鉴权失效自动停用 (Auto-Disable on Exhaustion)</h3>
                <p>当某个账号额度耗尽或返回 401 鉴权失效时，当场无缝切流至其他健康账号完成回复，并自动暂停该账号（周期重置后自动唤醒）。</p>
              </div>
              <label class="switch"><input type="checkbox" id="cfgAutoDisable" /><span class="slider"></span></label>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <h3>无痕隐私模式 (Incognito Privacy Mode)</h3>
                <p>默认开启。使用 AWS Quick 官方原生无痕模式（incognito），不写入云端历史且不产生高频删会话请求；关闭后对话将保留在 AWS Quick 云端记录中，可随时在凭证页一键清理。</p>
              </div>
              <label class="switch"><input type="checkbox" id="cfgIncognitoMode" checked /><span class="slider"></span></label>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <h3>自动创建 / 绑定极简编程 Agent (AUTO_ENSURE_CODING_AGENT)</h3>
                <p>默认开启。首次调用尚未绑定 Agent 的账号时，自动通过 AWS Quick 协议查找已有自定义 Agent 或创建极简编程 Agent 并持久化绑定，大幅提升 Opus / Sonnet 工具与本地文件调用稳定性并消除长篇防拒答提示词污染。</p>
              </div>
              <label class="switch"><input type="checkbox" id="cfgAutoEnsureCodingAgent" checked /><span class="slider"></span></label>
            </div>

            <div class="setting-row" style="flex-direction:column;align-items:stretch;gap:8px;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
                <div class="setting-info">
                  <h3>自定义 Agent 默认提示词模板 (CUSTOM_AGENT_PROMPT)</h3>
                  <p>新建或自动创建自定义 Agent 时写入的默认指令模板，保存后立即热生效（留空则使用内置默认模板；已创建的旧 Agent 可在「凭证池 → Agent」里一键编辑更新）。</p>
                </div>
                <button type="button" class="btn-xs" id="resetAgentPromptBtn" style="flex-shrink:0;">恢复默认</button>
              </div>
              <textarea id="cfgCustomAgentPrompt" rows="3" style="width:100%;resize:vertical;line-height:1.5;" placeholder="留空将使用内置极简默认模板"></textarea>
            </div>
          </div>

          <div class="panel-box">
            <div class="panel-hdr">
              <div>
                <h2>当前活跃粘性会话路由表</h2>
                <p>展示会话指纹与上游账号的实时绑定关系</p>
              </div>
              <button id="clearAffinityBtn">清空亲和绑定</button>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>会话指纹 (Conversation Key)</th>
                    <th>锁定账号槽位</th>
                    <th>亲和命中次数</th>
                    <th>最近活跃</th>
                    <th>剩余有效期</th>
                  </tr>
                </thead>
                <tbody id="affinityTableBody"></tbody>
              </table>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <!-- Slide-Over Request Trace Inspector Drawer -->
  <div class="drawer-mask" id="traceDrawer" role="dialog" aria-modal="true" aria-labelledby="drTitle" data-click-self="closeTraceDrawer">
    <div class="drawer-panel">
      <div class="drawer-hdr">
        <div>
          <div style="font-weight:600;font-size:14px;" id="drTitle">请求诊断（仅元数据）</div>
          <div class="mono" style="font-size:11px;color:var(--fg-muted);" id="drSubtitle">—</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-xs" id="drRefreshBtn">刷新详情</button>
          <button class="btn-xs btn-ghost" aria-label="关闭诊断抽屉" data-click="closeTraceDrawer">✕ 关闭</button>
        </div>
      </div>
      <div class="drawer-body" id="drBody"></div>
    </div>
  </div>

  <!-- Add Key Modal: import upstream AWS Quick credentials -->
  <div class="modal-mask" id="addModal" role="dialog" aria-modal="true" aria-labelledby="addModalTitle" data-click-self="closeAddModal">
    <div class="modal-card" style="max-width: 520px;">
      <div class="panel-hdr">
        <h2 id="addModalTitle">添加 AWS Quick 账号凭证</h2>
        <button class="btn-xs btn-ghost" aria-label="关闭弹窗" data-click="closeAddModal">✕</button>
      </div>
      <div style="padding:12px 18px 0;">
        <div class="seg-tabs">
          <button type="button" class="seg-tab active" id="addTabOAuth" style="flex:1.35;">网页授权（推荐 · 90天）</button>
          <button type="button" class="seg-tab" id="addTabCurl" style="flex:0.85;">Cookie 导入</button>
          <button type="button" class="seg-tab" id="addTabBatch" style="flex:0.85;">批量导入</button>
        </div>
      </div>
      <div class="modal-body" id="addPaneOAuth" style="gap:12px;">
        <div class="oauth-stepper">
          <button type="button" class="oauth-step-pill active" id="oauthStepPill1" title="返回第 1 步"><span class="oauth-step-num" id="oauthStepNum1">1</span><span>识别账号</span></button>
          <span class="oauth-step-line" id="oauthStepLine"></span>
          <span class="oauth-step-pill" id="oauthStepPill2"><span class="oauth-step-num" id="oauthStepNum2">2</span><span>同意授权</span></span>
        </div>

        <div class="oauth-card" id="oauthStep1Card">
          <div class="oauth-step-kicker">
            <span>第 1 步 · 识别账号归属</span>
            <span class="oauth-step-tag">1 / 2</span>
          </div>
          <div style="font-size:12px;color:var(--fg-muted);line-height:1.55;">
            先识别你的账号所在区域：复制下方链接到已登录 AWS Quick 的浏览器打开，页面跳转报错后，把地址栏 URL 粘贴回来。
          </div>
          <button type="button" class="btn-solid" id="oauthDiscoveryCopyBtn" style="width:100%;justify-content:center;padding:8px 12px;font-size:12.5px;">复制第 1 步链接（识别账号）</button>
          <div style="display:flex;gap:6px;align-items:center;">
            <input id="oauthDiscoveryCallbackInput" type="text" class="mono" style="flex:1;font-size:11.5px;background:var(--panel);" placeholder="粘贴 localhost:18080/callback?... 地址（粘贴自动进第 2 步）" />
            <button type="button" class="btn-xs" id="oauthStartBtn" style="flex-shrink:0;">下一步</button>
          </div>
        </div>

        <div id="oauthStep2Wrap" style="display:none;flex-direction:column;gap:10px;">
          <div class="oauth-done-bar">
            <span style="display:inline-flex;align-items:center;gap:6px;font-weight:500;">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.2 8.2L7.1 10.1L11 6" stroke="var(--panel)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span id="oauthStep1SummaryText">第 1 步已完成</span>
            </span>
            <button type="button" class="btn-xs" id="oauthResetStepBtn" style="padding:2px 8px;font-size:11.5px;">← 返回上一步</button>
          </div>
          <div class="oauth-card oauth-card-step2">
            <div class="oauth-step-kicker">
              <span>最后一步 · 获取 90 天授权</span>
              <span class="oauth-step-tag">2 / 2</span>
            </div>
            <div style="font-size:12px;color:var(--fg-muted);line-height:1.55;">
              账号已识别成功！复制下方<strong>专属授权链接</strong>到同一个浏览器打开并点「Allow access」，跳转报错后把地址栏粘回即完成绑定。
            </div>
            <button type="button" class="btn-solid" id="oauthCopyBtn" style="width:100%;justify-content:center;padding:8px 12px;font-size:12.5px;">复制授权链接（去点 Allow access）</button>
            <div style="display:flex;gap:6px;align-items:center;">
              <input id="oauthCallbackInput" type="text" class="mono" style="flex:1;font-size:11.5px;background:var(--subtle);" placeholder="粘贴 127.0.0.1:18080/?code=... 地址（粘贴自动完成）" />
              <button type="button" class="btn-xs" id="oauthCompleteBtn" style="flex-shrink:0;">完成授权</button>
            </div>
            <div id="oauthStatusText" style="font-size:11.5px;color:var(--fg-muted);"></div>
          </div>
        </div>
      </div>
      <div class="modal-body" id="addPaneCurl" style="display:none;gap:10px;">
        <div class="oauth-card">
          <div class="oauth-step-kicker">
            <span>网页 Cookie / 凭证导入</span>
            <span class="oauth-step-tag">短期备用</span>
          </div>
          <div style="font-size:12px;color:var(--fg-muted);line-height:1.55;">
            在已登录 <span class="mono">quick.aws.com</span> 的浏览器按 F12 → 打开「网络 (Network)」→ 右键任意请求选「复制为 cURL」粘贴到下方（也支持直接粘贴 <span class="mono">oauth:...</span> 或 <span class="mono">web:...</span> 凭证）。
          </div>
          <textarea id="modalKeysInput" rows="4" class="mono" style="width:100%;font-size:11.5px;background:var(--panel);" placeholder="粘贴包含 Cookie 的请求（Copy as cURL）或已有凭证字符串..."></textarea>
        </div>
      </div>
      <div class="modal-body" id="addPaneBatch" style="display:none;gap:10px;">
        <div class="oauth-card">
          <div class="oauth-step-kicker">
            <span>JSON 备份批量恢复</span>
            <span class="oauth-step-tag">保留备注与代理</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px dashed var(--border-strong);border-radius:7px;background:var(--panel);">
            <div style="font-size:12px;color:var(--fg-muted);line-height:1.45;">
              <div style="color:var(--fg);font-weight:500;" id="batchFileStatusLabel">上传 JSON 备份文件</div>
              <div>支持「导出 JSON」生成的备份，自动还原备注、独立代理与启停状态</div>
            </div>
            <button type="button" class="btn-xs" id="importJsonFileBtn" style="flex-shrink:0;">选择文件</button>
            <input type="file" id="importJsonFileInput" accept=".json,application/json" style="display:none;" />
          </div>
          <textarea id="modalBatchJsonInput" rows="4" class="mono" style="width:100%;font-size:11.5px;background:var(--panel);" placeholder='或直接粘贴 JSON 数组，例如 [{"apiKey":"oauth:...","label":"主力 1号","proxyUrl":"","enabled":true}]'></textarea>
        </div>
      </div>
      <div class="modal-body" id="addMoreOptionsWrap" style="padding-top:12px;border-top:1px solid var(--border);gap:10px;">
        <div>
          <label class="field-lbl">备注名称（可选，建议填邮箱或昵称方便区分）</label>
          <input id="modalLabelInput" type="text" style="width:100%;" placeholder="例如：user@gmail.com 或 主力 1号（留空自动编号）" />
        </div>
        <details id="addMoreOptions" class="more-opt-details">
          <summary id="addMoreOptionsSummary">更多选项（独立代理 / 初始状态 / 企业工作区）</summary>
          <div class="more-opt-inner">
            <div id="oauthAccountTypeRow">
              <label class="field-lbl">账号类型</label>
              <select id="oauthAccountTypeSelect" style="width:100%;">
                <option value="personal">个人版账号（默认，支持各类个人登录方式）</option>
                <option value="enterprise">企业 SSO 工作区（自定义 Issuer URL / WS Host）</option>
              </select>
            </div>
            <div id="oauthEnterpriseFields" style="display:none;gap:8px;flex-wrap:wrap;">
              <input id="oauthIssuerInput" type="text" class="mono" style="flex:1;min-width:200px;font-size:11.5px;background:var(--panel);" placeholder="企业 Issuer URL（含 ssoins-...）" />
              <input id="oauthWsHostInput" type="text" class="mono" style="flex:1;min-width:200px;font-size:11.5px;background:var(--panel);" placeholder="企业 WS Host（如 qbs-cell....aws.dev）" />
            </div>
            <div style="display:flex;gap:10px;">
              <div style="flex:1;">
                <label class="field-lbl">独立出口代理（可选，支持 http/https/socks5 及 ip:port:user:pass）</label>
                <input id="modalProxyInput" type="text" class="mono" style="width:100%;background:var(--panel);" placeholder="如 socks5://user:pass@1.2.3.4:1080 或 1.2.3.4:8080:user:pass" />
              </div>
              <div>
                <label class="field-lbl">初始状态</label>
                <select id="modalEnabledSelect" style="background:var(--panel);">
                  <option value="true">立即启用</option>
                  <option value="false">停用备用</option>
                </select>
              </div>
            </div>
            <div>
              <label class="field-lbl">专属自定义 Agent ID（可选，覆盖全局 chat_agent_id，留空跟随全局设置）</label>
              <input id="modalChatAgentInput" type="text" class="mono" style="width:100%;background:var(--panel);" placeholder="如自定义 Quick Agent UUID / ARN（可选）" />
            </div>
          </div>
        </details>
      </div>
      <div class="modal-foot" id="addFootCrsr">
        <button data-click="closeAddModal">关闭</button>
        <button class="btn-solid" id="confirmAddKeyBtn" style="display:none;">确认导入并同步额度</button>
      </div>
    </div>
  </div>

  <!-- Version / Update Notification Modal -->
  <div class="modal-mask" id="updateModal" role="dialog" aria-modal="true" aria-labelledby="updateModalTitle" data-click-self="closeUpdateModal">
    <div class="modal-card" style="max-width: 560px;">
      <div class="panel-hdr">
        <h2 id="updateModalTitle">版本信息与更新指南</h2>
        <button class="btn-xs btn-ghost" aria-label="关闭弹窗" data-click="closeUpdateModal">✕</button>
      </div>
      <div class="modal-body" id="updateModalBody" style="font-size:12.5px;line-height:1.6;"></div>
      <div class="modal-foot">
        <button class="btn-xs" id="recheckVersionBtn" type="button">重新检查更新</button>
        <button class="btn-solid" data-click="closeUpdateModal">关闭</button>
      </div>
    </div>
  </div>

  <!-- Unified System-Themed Input Modal (replaces native window.prompt) -->
  <div class="modal-mask" id="uiPromptModal" role="dialog" aria-modal="true" style="z-index:80;">
    <div class="modal-card" style="max-width: 440px;">
      <div class="panel-hdr">
        <h2 id="uiPromptTitle">输入</h2>
        <button class="btn-xs btn-ghost" id="uiPromptCloseBtn" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body" style="gap:8px;">
        <div id="uiPromptDesc" style="font-size:12.5px;color:var(--fg-muted);line-height:1.5;"></div>
        <input id="uiPromptInput" type="text" class="mono" style="width:100%;" />
      </div>
      <div class="modal-foot">
        <button type="button" id="uiPromptCancelBtn">取消</button>
        <button type="button" class="btn-solid" id="uiPromptOkBtn">确定</button>
      </div>
    </div>
  </div>

  <!-- Unified System-Themed Confirm Modal (replaces native window.confirm) -->
  <div class="modal-mask" id="uiConfirmModal" role="dialog" aria-modal="true" style="z-index:80;">
    <div class="modal-card" style="max-width: 420px;">
      <div class="panel-hdr">
        <h2 id="uiConfirmTitle">确认操作</h2>
        <button class="btn-xs btn-ghost" id="uiConfirmCloseBtn" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">
        <div id="uiConfirmDesc" style="font-size:13px;color:var(--fg);line-height:1.6;"></div>
      </div>
      <div class="modal-foot">
        <button type="button" id="uiConfirmCancelBtn">取消</button>
        <button type="button" class="btn-solid" id="uiConfirmOkBtn">确认</button>
      </div>
    </div>
  </div>

  <!-- Top-right Floating Toast Container -->
  <div class="toast-stack" id="toastStack" aria-live="polite"></div>

  <!-- Create / Edit Client Gateway Sub-Key Modal -->
  <div class="modal-mask" id="clientKeyModal" role="dialog" aria-modal="true" aria-labelledby="ckModalTitle" data-click-self="closeCkModal">
    <div class="modal-card" style="max-width: 720px;">
      <div class="panel-hdr" style="flex-shrink:0;">
        <h2 id="ckModalTitle">创建网关子密钥</h2>
        <button class="btn-xs btn-ghost" aria-label="关闭弹窗" data-click="closeCkModal">✕</button>
      </div>
      <div class="modal-body">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;">
          <div>
            <label class="field-lbl">密钥名称备注</label>
            <input id="ckNameInput" type="text" style="width:100%;" placeholder="例如：分享给前端组 Key / 临时测试 Key" />
          </div>
          <div id="ckTokenFieldWrap">
            <label class="field-lbl">自定义 Token (留空自动生成 sk-aq-...)</label>
            <input id="ckTokenInput" type="text" class="mono" style="width:100%;" placeholder="留空自动生成高强度随机密钥" />
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;padding:12px;background:var(--subtle);border:1px solid var(--border);border-radius:6px;">
          <div>
            <label class="field-lbl">最大调用次数限制 (留空或 0 = 无限制)</label>
            <input id="ckMaxReqInput" type="number" min="0" step="1" class="mono" style="width:100%;" placeholder="无次数限制" />
            <div class="preset-pills">
              <button type="button" class="btn-xs" data-click="setCkMaxReq" data-arg="">无限制</button>
              <button type="button" class="btn-xs" data-click="setCkMaxReq" data-arg="50">50 次</button>
              <button type="button" class="btn-xs" data-click="setCkMaxReq" data-arg="200">200 次</button>
              <button type="button" class="btn-xs" data-click="setCkMaxReq" data-arg="1000">1,000 次</button>
            </div>
          </div>
          <div>
            <label class="field-lbl">最大并发请求数 (留空或 0 = 不限制)</label>
            <input id="ckMaxConcInput" type="number" min="0" step="1" class="mono" style="width:100%;" placeholder="不限制并发" />
            <div class="preset-pills">
              <button type="button" class="btn-xs" data-click="setCkMaxConc" data-arg="">不限制</button>
              <button type="button" class="btn-xs" data-click="setCkMaxConc" data-arg="3">3</button>
              <button type="button" class="btn-xs" data-click="setCkMaxConc" data-arg="8">8</button>
              <button type="button" class="btn-xs" data-click="setCkMaxConc" data-arg="16">16</button>
            </div>
          </div>
          <div>
            <label class="field-lbl">到期失效时间 (留空 = 永不过期)</label>
            <input id="ckExpiresInput" type="datetime-local" class="mono" style="width:100%;" />
            <div class="preset-pills">
              <button type="button" class="btn-xs" data-click="setCkExpDays" data-arg="0">永不过期</button>
              <button type="button" class="btn-xs" data-click="setCkExpDays" data-arg="1">+1 天</button>
              <button type="button" class="btn-xs" data-click="setCkExpDays" data-arg="7">+7 天</button>
              <button type="button" class="btn-xs" data-click="setCkExpDays" data-arg="30">+30 天</button>
            </div>
          </div>
        </div>

        <div>
          <label class="field-lbl">模型访问权限策略</label>
          <select id="ckScopeSelect" style="width:100%;">
            <option value="all">允许访问全部全局已启用模型 (无单独模型限制)</option>
            <option value="custom">仅允许访问下方勾选的指定模型 (自定义模型白名单)</option>
          </select>
        </div>

        <div id="ckModelsPickerWrap" style="display:none;border:1px solid var(--border);border-radius:6px;overflow:hidden;">
          <div style="padding:9px 12px;background:var(--subtle);border-bottom:1px solid var(--border);display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <input id="ckModelSearch" type="text" placeholder="搜索模型 ID 或名称..." style="flex:1;min-width:140px;padding:5px 9px;font-size:12px;" />
            <span class="mono" style="font-size:11.5px;color:var(--fg-muted);margin:0 4px;" id="ckPickedCountLabel">已选 0 项</span>
            <button type="button" class="btn-xs" id="ckPickAllBtn">全选</button>
            <button type="button" class="btn-xs" id="ckPickNoneBtn">清空</button>
          </div>
          <div id="ckModelsChecklist" class="ck-grid"></div>
        </div>
      </div>
      <div class="modal-foot">
        <button data-click="closeCkModal">取消</button>
        <button class="btn-solid" id="saveCkModalBtn">保存网关密钥配置</button>
      </div>
    </div>
  </div>

  <div id="cSelMenu" class="c-sel-menu" role="listbox"></div>
  <div id="ovTip" class="ov-tip" aria-hidden="true"></div>

  <script nonce="${nonce}">
    const DASH_PATH = ${serializedDashPath};
    const cleanPathname = location.pathname.replace(/\\/+$/, "");
    const basePath = cleanPathname.endsWith(DASH_PATH)
      ? cleanPathname.slice(0, cleanPathname.length - DASH_PATH.length)
      : cleanPathname.replace(/\\/(dashboard|status)$/, "");
    const THEME_KEY = "cgw_ui_theme";
    const LANG_KEY = "cgw_ui_lang";
    let currentLang = localStorage.getItem(LANG_KEY) || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
    let lastConsoleData = null;
    let lastOverviewData = null;
    let sessionBearer = sessionStorage.getItem("cgw_session_bearer") || "";
    let activeTab = "overview";
    let poolSlotsCache = [];
    let logsCache = [];
    let liveLogsPoll = true;
    let openTraceId = null;
    let openTraceDetail = null;

    let modelsCatalogCache = [];
    const selectedModelIds = new Set();
    let clientKeysCache = [];
    let editingCkId = null;
    const ckPickedModels = new Set();

    const $ = (id) => document.getElementById(id);

    const EN_STATIC = {
      "全量模型权限总表": "Full Model Access Matrix",
      "一键切换模型启用状态，或使用批量操作进行白名单管控": "Toggle individual model availability or batch-manage allowlists",
      "当前内存中会话哈希与上游账号绑定映射": "Live in-memory mapping between conversation hashes and upstream accounts",
      "暂无活跃的粘性会话（请求发起后会自动在此建立绑定）": "No active sticky sessions (bindings are established automatically upon request)",
      "展示会话指纹与上游账号的实时绑定关系": "Live mapping between conversation hashes and upstream account slots",
      "多账号调度、亲和性与熔断策略": "Routing, Sticky Affinity & Circuit Breakers",
      "对齐 CPA 生产级路由机制，修改后立即生效并自动持久化写回服务器 .env": "Changes take effect immediately and persist to .env",
      "保存路由配置": "Save Routing",

      "输入管理员访问密码以解锁多账号调度、模型权限、实时日志与额度中心。": "Enter the admin password to unlock account pool routing, model access, live logs, and quota telemetry.",
      "管理员密码": "Admin password",
      "验证并进入控制台": "Sign In to Console",
      "总览监控": "Overview",
      "实时请求日志": "Request Logs",
      "凭证与额度池": "Credentials & Quotas",
      "网关子密钥管理": "Client Sub-Keys",
      "模型权限管理": "Model Access",
      "路由与亲和策略": "Routing & Affinity",
      "在线测试与接入": "Playground & Setup",
      "改密": "Password",
      "退出": "Sign Out",
      "同步最新额度": "Sync Quotas",
      "+ 添加凭证": "+ Add Key",
      "关闭": "Close",
      "今天": "Today",
      "近 7 天": "Last 7 Days",
      "近 30 天": "Last 30 Days",
      "统计仅记录模型、子密钥、客户端 IP、账号与 token 数，不保存任何对话内容": "Metadata only (model, sub-key, client IP, account, token counts). Conversation content is never stored.",
      "请求数": "Requests",
      "错误 0": "Errors 0",
      "成功率 —": "Success Rate —",
      "Token 总量": "Total Tokens",
      "输入 0 · 缓存 0 · 输出 0": "In 0 · Cache 0 · Out 0",
      "缓存命中率": "Cache Hit Rate",
      "缓存读取占输入侧比例": "Cached reads as share of input",
      "可用账号": "Active Accounts",
      "活跃并发流: 0 · 自动熔断: 0": "In-flight: 0 · Auto-tripped: 0",
      "模型分布（按 Token）": "Model Breakdown (by Tokens)",
      "Token 趋势": "Token Trend",
      "2 步快速开始使用": "Quick Start in 2 Steps",
      "查看调用密钥 →": "View API Keys →",
      "按模型": "Models",
      "按账号": "Accounts",
      "按子密钥": "Sub-Keys",
      "查看全部日志 →": "All Logs →",
      "子密钥消耗 Top": "Top Sub-Keys",
      "账号池实时额度速览 (Session 池 & Monthly 10h 池)": "Account Pool Quota Snapshot (Session & Monthly 10h Pools)",
      "Session 池已用": "Session Pool Used",
      "Monthly 10h 池已用": "Monthly 10h Used",
      "AWS Quick 凭证管理": "AWS Quick Credential Pool",
      "绑定账号、Token 剩余与云端会话": "Account, Token TTL & Cloud Sessions",
      "添加 AWS Quick 账号凭证": "Add AWS Quick Credentials",
      "点击任意账号行可直接跳转查看该账号的专属实时请求日志": "Click any account row to filter live request logs for that account",
      "状态": "Status",
      "账号标识 / 邮箱": "Account / Email",
      "套餐": "Plan",
      "Session 池已用": "Session Pool Used",
      "高级 API 已用额度": "Premium API Used",
      "Bot 额度": "Bot Quota",
      "总额度池 / 按需支出": "Included / On-Demand",
      "运行与调度": "Status & Dispatch",
      "批量检测": "Batch Check",
      "最近请求": "Recent Requests",
      "仅元数据，网关不保存任何对话内容": "Metadata only; conversation text is never retained",
      "全部 IP": "All IPs",
      "全部子密钥": "All Sub-Keys",
      "全部客户端": "All Clients",
      "时间": "Time",
      "模型": "Model",
      "子密钥": "Sub-Key",
      "客户端 IP": "Client IP",
      "客户端": "Client",
      "账号": "Account",
      "耗时": "Duration",
      "输入 / 缓存 / 输出": "In / Cache / Out",
      "实时请求日志（仅元数据，点击任意行查看复用诊断）": "Live Request Logs (metadata only; click a row for trace diagnostics)",
      "网关不保存任何对话内容：只记录模型、账号、耗时、token、字符数与单向指纹；「工具热续跑」仅发送新增工具结果增量": "No conversation text is saved: only model, account, latency, tokens, char counts, and one-way hashes.",
      "全部执行账号": "All Accounts",
      "全部请求类型": "All Types",
      "生成中": "Running",
      "含工具调用": "With Tools",
      "含思考链": "With Thinking",
      "异常报错": "Errors",
      "搜模型 / 客户端 / UA...": "Search model / client / UA...",
      "实时刷新(3s): 开": "Live Poll (3s): ON",
      "刷新": "Refresh",
      "清空": "Clear",
      "模型 / 协议": "Model / Protocol",
      "执行账号 / 模式": "Account / Mode",
      "输出与上下文规模": "Output & Context Size",
      "首包 / 总耗时": "TTFT / Total",
      "新发 / 缓存 / 输出": "In / Cache / Out",
      "AWS Quick 凭证管理": "AWS Quick Credentials",
      "支持多账号自动轮询、限流指数退避冷却、额度归零自动熔断关停与热启停": "Multi-account load balancing, rate-limit cooldowns, quota auto-circuit-breaker, and hot toggling",
      "启用": "Enabled",
      "备注 / 掩码凭证": "Label / Masked Key",
      "绑定账号与周期": "Account & Billing Cycle",
      "Auto 池已用": "Auto Pool Used",
      "API 池已用": "API Pool Used",
      "账单详情": "Billing",
      "运行状态与统计": "Runtime Status & Stats",
      "操作": "Actions",
      "网关对外调用密钥管理 (Client Gateway Sub-Keys)": "Client Gateway Sub-Keys",
      "支持创建多把网关子密钥分发给不同客户端或同事，每把密钥可独立勾选允许访问的模型白名单并统计用量": "Issue client sub-keys with independent model allowlists, request/concurrency caps, and expiration",
      "+ 创建网关子密钥": "+ Create Sub-Key",
      "密钥名称": "Name",
      "Token (点击安全复制)": "Token (Click to Copy)",
      "可访问模型范围": "Allowed Models",
      "次数限制 / 有效期": "Quota / Expiry",
      "累计 Token / 最近调用": "Tokens / Last Used",
      "对外开放模型列表与启停管理 (Model Access Control)": "Model Access Control",
      "刷新上游模型目录": "Refresh Catalog",
      "搜索模型 ID 或名称...": "Search model ID or name (e.g. claude-sonnet-5-5, claude-opus-5-5)...",
      "全部额度池": "All Pools",
      "全部模型": "All Models",
      "仅已启用": "Enabled Only",
      "仅已禁用": "Disabled Only",
      "已勾选 0 项": "0 selected",
      "批量启用勾选": "Enable Selected",
      "批量禁用勾选": "Disable Selected",
      "仅启用勾选项(白名单)": "Whitelist Selected",
      "仅保留当前勾选的模型启用，其余全部禁用": "Keep only selected models enabled and disable all others",
      "一键禁用全部 API 池模型": "Disable All API Pool",
      "一键禁用所有消耗外部 API 池的 Claude/GPT/Gemini 模型": "Disable all Claude/GPT/Gemini models that consume the Premium API pool",
      "全部恢复启用": "Enable All",
      "全选当前筛选列表": "Select all filtered models",
      "对外状态": "Enabled",
      "模型 ID (Model ID)": "Model ID",
      "显示名称": "Display Name",
      "所属扣费池": "Quota Pool",
      "支持调节参数": "Supported Params",
      "点击左侧菜单自动加载实时模型目录...": "Loading live model catalog...",
      "多账号调度、亲和性与熔断策略": "Routing, Sticky Affinity & Circuit Breaker",
      "对齐 CPA 生产级路由机制，修改后立即生效并自动持久化写回服务器 .env": "Changes take effect immediately and persist to .env",
      "保存路由配置": "Save Routing",
      "负载均衡算法 (Load Balancing Strategy)": "Load Balancing Strategy",
      "Quota-Aware 会识别请求模型所属额度池（Session 池 vs Monthly 10h 池），优先分配给仍有余量且当前活跃并发最少的账号。": "Quota-Aware inspects the target pool (Session vs Monthly 10h) and picks the healthiest account with remaining quota and lowest concurrency.",
      "Quota-Aware (余量感知 + 最少并发)": "Quota-Aware (Balance + Least Busy)",
      "Least-Busy (最少活跃并发优先)": "Least-Busy (Lowest In-Flight)",
      "Round-Robin (均匀轮询)": "Round-Robin",
      "会话粘性亲和 (Sticky Session Affinity)": "Sticky Session Affinity",
      "开启后，同一对话窗口在有效期内始终锁定同一健康账号执行，防止跨号跳跃；若原账号耗尽或限流则自动漂移至健康账号。": "Keeps multi-turn conversations pinned to the same healthy account within TTL; fails over automatically on exhaustion or 429.",
      "TTL(秒):": "TTL (s):",
      "账号没钱 / 鉴权失效自动熔断关停 (Auto-Disable on Exhaustion)": "Auto-Disable on Exhaustion / 401",
      "当 A 账号返回额度耗尽、双池余量均归零或 401 失效时，当场无缝切流至 B 账号完成回复，并自动关停 A 账号（下个周期自动唤醒）。": "Fails over mid-request when an account runs out of quota or returns 401, and disables it until billing reset.",
      "当前活跃粘性会话路由表": "Active Sticky Session Bindings",
      "展示会话指纹与上游账号的实时绑定关系": "Live mapping between conversation hashes and upstream account slots",
      "清空亲和绑定": "Clear Bindings",
      "会话指纹 (Conversation Key)": "Conversation Key",
      "锁定账号槽位": "Pinned Account Slot",
      "亲和命中次数": "Affinity Hits",
      "最近活跃": "Last Active",
      "剩余有效期": "Remaining TTL",
      "在线拨测台 (Live Request Tester)": "Live Request Playground",
      "发送测试消息后，可切到左侧「实时请求日志」查看该请求的执行模式、耗时与 token": "Send a test prompt, then inspect its execution mode, TTFT, and tokens in Request Logs",
      "发送测试": "Send Test",
      "点击「发送测试」查看实时返回结果与思考链...": "Click Send Test to inspect live response and reasoning...",
      "标准协议接入端点": "Client Integration Endpoints",
      "OpenAI 兼容客户端 (Kilo / Kiro / Roo Code / Cline / NextChat)": "OpenAI-Compatible Clients (Kilo / Roo Code / Cline / Codex / NextChat)",
      "Anthropic Claude 原生协议 (Claude Code CLI / @ai-sdk/anthropic)": "Anthropic Claude Native Clients (Claude Code CLI / @ai-sdk/anthropic)",
      "请求诊断（仅元数据）": "Trace Diagnostics (Metadata Only)",
      "刷新详情": "Refresh",
      "✕ 关闭": "✕ Close",
      "关闭诊断抽屉": "Close diagnostics drawer",
      "添加 AWS Quick 账号凭证": "Add AWS Quick Credentials",
      "关闭弹窗": "Close modal",
      "AWS Quick 凭证 (填入 local-outpost 或直接粘贴 id_token，支持每行一条)": "AWS Quick Credentials (local-outpost or id_token, one per line)",
      "备注名称 (可选，如：主力 Pro 号)": "Label (optional, e.g. Primary Pro)",
      "例如：主力 Pro 2号": "e.g. Primary Pro #2",
      "初始状态": "Initial State",
      "立即启用负载": "Enabled (Active)",
      "停用封存备用": "Disabled (Standby)",
      "检查该账号已有 Key": "Check Existing Keys",
      "确认创建新 Key 并导入": "Create & Import New Key",
      "取消": "Cancel",
      "确认导入并同步额度": "Import & Sync Quotas",
      "创建网关子密钥": "Create Client Sub-Key",
      "密钥名称备注": "Sub-Key Name",
      "例如：分享给前端组 Key / 临时测试 Key": "e.g. Frontend Team / Dev Key",
      "自定义 Token (留空自动生成 sk-aq-...)": "Custom Token (blank = auto-generate sk-aq-...)",
      "留空自动生成高强度随机密钥": "Leave blank for random high-entropy token",
      "最大调用次数限制 (留空或 0 = 无限制)": "Max Requests (blank or 0 = unlimited)",
      "无次数限制": "Unlimited",
      "无限制": "Unlimited",
      "50 次": "50",
      "200 次": "200",
      "1,000 次": "1,000",
      "最大并发请求数 (留空或 0 = 不限制)": "Max Concurrent Requests (blank or 0 = unlimited)",
      "不限制并发": "Unlimited",
      "不限制": "Unlimited",
      "到期失效时间 (留空 = 永不过期)": "Expiration Time (blank = never expires)",
      "永不过期": "Never",
      "+1 天": "+1d",
      "+7 天": "+7d",
      "+30 天": "+30d",
      "模型访问权限策略": "Model Access Policy",
      "允许访问全部全局已启用模型 (无单独模型限制)": "Allow all globally enabled models (unrestricted)",
      "仅允许访问下方勾选的指定模型 (自定义模型白名单)": "Allow only checked models below (custom allowlist)",
      "搜索模型 ID 或名称...": "Search model ID or name...",
      "已选 0 项": "0 picked",
      "仅勾 Auto 免费池": "Auto Pool Only",
      "全选": "Select All",
      "保存网关密钥配置": "Save Sub-Key"
    };


    // ==================== CUSTOM STYLED SELECTS ====================
    const cSelMenu = $("cSelMenu");
    let cSelActive = null;
    function closeCSelMenu() {
      if (cSelMenu) cSelMenu.classList.remove("open");
      if (cSelActive) { cSelActive.trigger.classList.remove("open"); cSelActive = null; }
    }
    function syncSelectUi(sel) {
      if (!sel || !sel._cSelTrigger) return;
      const opt = sel.options[sel.selectedIndex] || sel.options[0];
      sel._cSelLbl.textContent = opt ? opt.textContent : "";
      if (sel.classList.contains("mono")) sel._cSelTrigger.classList.add("mono");
    }
    function enhanceSelect(sel) {
      if (!sel || sel._cSelWrap) { syncSelectUi(sel); return; }
      const wrap = document.createElement("div");
      wrap.className = "c-sel-wrap";
      if (sel.style.minWidth) wrap.style.minWidth = sel.style.minWidth;
      if (sel.style.width) wrap.style.width = sel.style.width;
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "c-sel-trigger" + (sel.classList.contains("mono") ? " mono" : "");
      const lbl = document.createElement("span");
      lbl.className = "c-sel-trigger-lbl";
      trigger.appendChild(lbl);
      const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      chev.setAttribute("viewBox", "0 0 24 24");
      chev.setAttribute("fill", "none");
      chev.setAttribute("stroke", "currentColor");
      chev.setAttribute("stroke-width", "2");
      chev.setAttribute("class", "c-sel-chev");
      chev.innerHTML = '<polyline points="6 9 12 15 18 9"/>';
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);
      wrap.appendChild(trigger);
      wrap.appendChild(chev);
      sel.classList.add("c-sel-native");
      sel._cSelWrap = wrap;
      sel._cSelTrigger = trigger;
      sel._cSelLbl = lbl;
      syncSelectUi(sel);
      trigger.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (cSelActive && cSelActive.sel === sel) { closeCSelMenu(); return; }
        closeCSelMenu();
        cSelActive = { sel, trigger };
        trigger.classList.add("open");
        cSelMenu.innerHTML = "";
        Array.from(sel.options).forEach((o) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "c-sel-opt" + (o.value === sel.value ? " active" : "") + (sel.classList.contains("mono") ? " mono" : "");
          const t = document.createElement("span");
          t.textContent = o.textContent;
          const chk = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          chk.setAttribute("viewBox", "0 0 24 24");
          chk.setAttribute("fill", "none");
          chk.setAttribute("stroke", "currentColor");
          chk.setAttribute("stroke-width", "2.4");
          chk.setAttribute("class", "c-sel-chk");
          chk.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
          item.appendChild(t);
          item.appendChild(chk);
          item.onclick = () => {
            if (sel.value !== o.value) {
              sel.value = o.value;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
            }
            syncSelectUi(sel);
            closeCSelMenu();
          };
          cSelMenu.appendChild(item);
        });
        const rect = trigger.getBoundingClientRect();
        cSelMenu.style.minWidth = Math.max(rect.width, 160) + "px";
        cSelMenu.classList.add("open");
        const mw = cSelMenu.offsetWidth || rect.width;
        const mh = cSelMenu.offsetHeight || 200;
        const left = Math.min(window.innerWidth - mw - 12, Math.max(12, rect.left));
        const top = rect.bottom + mh + 12 > window.innerHeight ? Math.max(12, rect.top - mh - 4) : rect.bottom + 4;
        cSelMenu.style.left = left + "px";
        cSelMenu.style.top = top + "px";
      });
    }
    function syncAllSelects() { document.querySelectorAll("select").forEach(enhanceSelect); }
    document.addEventListener("click", closeCSelMenu);
    window.addEventListener("resize", closeCSelMenu);

    function tr(zh, en) { return currentLang === "en" ? en : zh; }

    const nodeOrigMap = new WeakMap();
    function applyDomI18n() {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walk.nextNode())) {
        const p = node.parentElement;
        if (!p || p.tagName === "SCRIPT" || p.tagName === "STYLE" || p.classList.contains("mono")) continue;
        const raw = node.nodeValue || "";
        const trimmed = raw.trim();
        if (!trimmed) continue;

        let orig = nodeOrigMap.get(node);
        if (!orig && EN_STATIC[trimmed]) {
          orig = trimmed;
          nodeOrigMap.set(node, orig);
        }
        if (orig) {
          const target = currentLang === "en" ? (EN_STATIC[orig] || orig) : orig;
          node.nodeValue = raw.replace(trimmed, target);
        }
      }
      document.querySelectorAll("[placeholder],[title],[aria-label]").forEach((el) => {
        ["placeholder", "title", "aria-label"].forEach((attr) => {
          const cur = el.getAttribute(attr);
          if (!cur) return;
          const dataAttr = "data-i18n-orig-" + attr;
          if (!el.hasAttribute(dataAttr) && EN_STATIC[cur]) el.setAttribute(dataAttr, cur);
          if (el.hasAttribute(dataAttr)) {
            const orig = el.getAttribute(dataAttr) || "";
            el.setAttribute(attr, currentLang === "en" ? (EN_STATIC[orig] || orig) : orig);
          }
        });
      });
    }

    function applyLang(lang) {
      currentLang = lang === "en" ? "en" : "zh";
      localStorage.setItem(LANG_KEY, currentLang);
      document.documentElement.lang = currentLang === "en" ? "en" : "zh-CN";
      applyDomI18n();
      if (typeof syncAllSelects === 'function') syncAllSelects();
      if ($("langToggleBtn")) $("langToggleBtn").querySelector(".tb-lbl").textContent = currentLang === "en" ? "EN" : "中文";
      if ($("loginLangBtn")) $("loginLangBtn").textContent = currentLang === "en" ? "中文" : "EN";
      if ($("pgPrompt") && ($("pgPrompt").value === "请先思考一下：为什么 0.1 + 0.2 在浮点数里不等于 0.3？用一句话总结。" || $("pgPrompt").value === "Briefly explain in one sentence why 0.1 + 0.2 !== 0.3 in floating-point arithmetic.")) {
        $("pgPrompt").value = currentLang === "en"
          ? "Briefly explain in one sentence why 0.1 + 0.2 !== 0.3 in floating-point arithmetic."
          : "请先思考一下：为什么 0.1 + 0.2 在浮点数里不等于 0.3？用一句话总结。";
      }
      if ($("themeToggleBtn")) applyTheme(document.documentElement.getAttribute("data-theme") || "light");
      if ($("livePollLogsBtn")) $("livePollLogsBtn").textContent = tr("实时刷新(3s): ", "Live Poll (3s): ") + (liveLogsPoll ? tr("开", "ON") : tr("关", "OFF"));
      if ($("topbarTitle")) $("topbarTitle").textContent = (tabTitles[activeTab] ? tabTitles[activeTab]() : tr("控制台", "Console"));
      if ($("onboardSteps")) $("onboardSteps").innerHTML = currentLang === "en" ? '1. Click <strong>+ Add Credential</strong> on the right and sign in once via browser (90-day auto-refresh).<br/>2. Click <strong>View API Keys →</strong> to copy your Base URL &amp; API Key into Claude Code, Cherry Studio, Cline, or any OpenAI/Anthropic client.' : '① 点击右侧「+ 添加凭证」，通过浏览器完成一次授权登录（支持 90 天自动续期）。<br/>② 点击「查看调用密钥 →」复制接口地址和 API Key，填进 Claude Code / Cherry Studio / Cline 等客户端即可对话。';
      if (lastConsoleData) renderAll(lastConsoleData);
      if (lastOverviewData) renderOverview(lastOverviewData);
      if (logsCache.length) renderLogsTable();
      if (openTraceDetail) renderDrawerContent();
      if (modelsCatalogCache.length) renderModelsTable();
      if (clientKeysCache.length) renderClientKeysTable();
      if ($("appShell").style.display !== "none") showConsole();
    }

    function applyTheme(t) {
      document.documentElement.setAttribute("data-theme", t);
      localStorage.setItem(THEME_KEY, t);
      $("themeToggleBtn").querySelector(".tb-lbl").textContent = t === "dark" ? tr("深色", "Dark") : tr("浅色", "Light");
    }
    applyTheme(localStorage.getItem(THEME_KEY) || "light");
    syncAllSelects();
    $("themeToggleBtn").onclick = () => {
      const cur = document.documentElement.getAttribute("data-theme");
      applyTheme(cur === "dark" ? "light" : "dark");
    };
    $("langToggleBtn").onclick = () => applyLang(currentLang === "zh" ? "en" : "zh");
    $("loginLangBtn").onclick = () => applyLang(currentLang === "zh" ? "en" : "zh");

    function notify(msg, isErr = false) {
      const stack = $("toastStack");
      if (!stack) return;
      const item = document.createElement("div");
      item.className = "toast-item " + (isErr ? "err" : "ok");
      const iconSvg = isErr
        ? '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.6V8.5M8 11.1H8.01" stroke="var(--panel)" stroke-width="1.6" stroke-linecap="round"/></svg>'
        : '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.2 8.2L7.1 10.1L11 6" stroke="var(--panel)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      item.innerHTML = '<span class="toast-icon">' + iconSvg + '</span><span style="flex:1;word-break:break-word;">' + esc(msg) + '</span><button type="button" class="toast-close" aria-label="Close">✕</button>';
      const remove = () => {
        if (item.parentNode) item.parentNode.removeChild(item);
      };
      item.querySelector(".toast-close").onclick = remove;
      stack.appendChild(item);
      while (stack.children.length > 4) stack.removeChild(stack.firstChild);
      setTimeout(remove, isErr ? 5000 : 3200);
    }
    window.hideNotice = () => {};

    function uiPrompt(opts) {
      return new Promise((resolve) => {
        const modal = $("uiPromptModal");
        const input = $("uiPromptInput");
        $("uiPromptTitle").textContent = opts.title || tr("输入", "Input");
        $("uiPromptDesc").textContent = opts.desc || "";
        input.type = opts.type || "text";
        input.placeholder = opts.placeholder || "";
        input.value = opts.value || "";
        $("uiPromptOkBtn").textContent = opts.okText || tr("确定", "Save");
        $("uiPromptCancelBtn").textContent = tr("取消", "Cancel");
        const finish = (val) => {
          modal.classList.remove("open");
          modal.onclick = null;
          input.onkeydown = null;
          $("uiPromptOkBtn").onclick = null;
          $("uiPromptCancelBtn").onclick = null;
          $("uiPromptCloseBtn").onclick = null;
          resolve(val);
        };
        $("uiPromptOkBtn").onclick = () => finish(input.value);
        $("uiPromptCancelBtn").onclick = () => finish(null);
        $("uiPromptCloseBtn").onclick = () => finish(null);
        modal.onclick = (e) => { if (e.target === modal) finish(null); };
        input.onkeydown = (e) => {
          if (e.key === "Enter") { e.preventDefault(); finish(input.value); }
          if (e.key === "Escape") { e.preventDefault(); finish(null); }
        };
        modal.classList.add("open");
        setTimeout(() => { input.focus(); input.select(); }, 40);
      });
    }

    function uiConfirm(opts) {
      return new Promise((resolve) => {
        const modal = $("uiConfirmModal");
        $("uiConfirmTitle").textContent = opts.title || tr("确认操作", "Confirm");
        $("uiConfirmDesc").textContent = opts.desc || "";
        const okBtn = $("uiConfirmOkBtn");
        okBtn.textContent = opts.okText || tr("确认", "Confirm");
        okBtn.className = opts.danger ? "btn-danger" : "btn-solid";
        $("uiConfirmCancelBtn").textContent = tr("取消", "Cancel");
        const finish = (ok) => {
          modal.classList.remove("open");
          modal.onclick = null;
          okBtn.onclick = null;
          $("uiConfirmCancelBtn").onclick = null;
          $("uiConfirmCloseBtn").onclick = null;
          resolve(ok);
        };
        okBtn.onclick = () => finish(true);
        $("uiConfirmCancelBtn").onclick = () => finish(false);
        $("uiConfirmCloseBtn").onclick = () => finish(false);
        modal.onclick = (e) => { if (e.target === modal) finish(false); };
        modal.classList.add("open");
        setTimeout(() => okBtn.focus(), 40);
      });
    }

    function esc(v) {
      const d = document.createElement("div");
      d.textContent = v == null ? "" : String(v);
      return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }
    // Friendly token counts: 1.2万 / 3.4亿 (zh) or 12.3K / 3.4M (en); full number stays in hover title.
    function fmtTok(n) {
      const v = Number(n || 0), a = Math.abs(v);
      if (currentLang === "en") {
        if (a >= 999950000) return String(Number((v / 1000000000).toFixed(2))) + "B";
        if (a >= 999950) return String(Number((v / 1000000).toFixed(2))) + "M";
        if (a >= 1000) return String(Number((v / 1000).toFixed(1))) + "K";
        return fmt(v);
      }
      if (a >= 99995000) return String(Number((v / 100000000).toFixed(2))) + "亿";
      if (a >= 10000) return String(Number((v / 10000).toFixed(a >= 1000000 ? 1 : 2))) + "万";
      return fmt(v);
    }
    function tokSpan(n, extraStyle) {
      return '<span title="' + esc(fmt(n)) + '"' + (extraStyle ? ' style="' + extraStyle + '"' : '') + '>' + fmtTok(n) + '</span>';
    }

    function barColor(used) {
      if (used == null) return "var(--fg-faint)";
      if (used >= 90) return "var(--err)";
      if (used >= 70) return "var(--warn)";
      return "var(--ok)";
    }


    async function api(path, opts = {}) {
      const headers = Object.assign({ "Content-Type": "application/json", "X-Console-CSRF": "1", "X-Console-Lang": currentLang }, opts.headers || {});
      if (sessionBearer) headers["Authorization"] = "Bearer " + sessionBearer;
      const res = await fetch(basePath + path, Object.assign({ credentials: "same-origin" }, opts, { headers }));
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        showLoginGate();
        throw new Error((data.error && data.error.message) || tr("登录会话已过期", "Session expired"));
      }
      if (!res.ok) {
        throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
      }
      return data;
    }

    let isInitialSetupMode = false;
    function applyLoginGateMode(setupMode) {
      isInitialSetupMode = Boolean(setupMode);
      const confirmEl = $("loginPwdConfirmInput");
      if (isInitialSetupMode) {
        if ($("loginGateTitle")) $("loginGateTitle").textContent = tr("初始化 aws-quick-admin", "Initialize aws-quick-admin");
        if ($("loginGateDesc")) $("loginGateDesc").textContent = tr("首次部署请设置管理员访问密码（至少 8 位），设置完成后自动保存并进入控制台。", "First-time setup: create an administrator password (min 8 chars) to secure your console.");
        $("loginPwdInput").placeholder = tr("设置管理员密码（至少 8 位）", "Create admin password (min 8 chars)");
        $("loginPwdInput").setAttribute("autocomplete", "new-password");
        if (confirmEl) {
          confirmEl.style.display = "block";
          confirmEl.required = true;
          confirmEl.placeholder = tr("再次确认管理员密码", "Confirm admin password");
        }
        $("loginSubmitBtn").textContent = tr("初始化密码并进入控制台", "Set Password & Continue");
      } else {
        if ($("loginGateTitle")) $("loginGateTitle").textContent = "aws-quick-admin";
        if ($("loginGateDesc")) $("loginGateDesc").textContent = tr("输入管理员访问密码以解锁多账号调度、模型权限、实时日志与额度中心。", "Enter your administrator password to access multi-account routing, models, logs, and quotas.");
        $("loginPwdInput").placeholder = tr("管理员密码", "Admin password");
        $("loginPwdInput").setAttribute("autocomplete", "current-password");
        if (confirmEl) {
          confirmEl.style.display = "none";
          confirmEl.required = false;
          confirmEl.value = "";
        }
        $("loginSubmitBtn").textContent = tr("验证并进入控制台", "Sign In");
      }
    }

    function showLoginGate(errMsg = "") {
      $("appShell").style.display = "none";
      $("loginGate").style.display = "flex";
      $("loginErrText").textContent = errMsg;
      setTimeout(() => $("loginPwdInput").focus(), 50);
    }

    function showConsole() {
      $("loginGate").style.display = "none";
      $("appShell").style.display = "grid";
    }

    const tabTitles = {
      overview: () => tr("总览监控", "Overview"),
      logs: () => tr("实时请求日志", "Request Logs"),
      credentials: () => tr("凭证与额度池", "Credentials & Quotas"),
      clientkeys: () => tr("网关子密钥管理", "Client Sub-Keys"),
      models: () => tr("模型权限管理", "Model Access"),
      routing: () => tr("路由与亲和策略", "Routing & Affinity")
    };

    function switchTab(tab) {
      activeTab = tab;
      if (tabTitles[tab]) { try { localStorage.setItem("aq_active_tab", tab); } catch {} }
      document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
      document.querySelectorAll(".view-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + tab));
      $("topbarTitle").textContent = tabTitles[tab] ? tabTitles[tab]() : tr("控制台", "Console");
      if (tab === "logs") fetchLogs();
      if (tab === "models" && modelsCatalogCache.length === 0) loadModelsCatalog();
      if (tab === "clientkeys") {
        loadClientKeys();
        if (modelsCatalogCache.length === 0) loadModelsCatalog();
      }
    }

    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.onclick = () => switchTab(btn.getAttribute("data-tab"));
    });

    window.jumpToAccountLogs = (slotId) => {
      $("logAccountFilter").value = slotId;
      syncSelectUi($("logAccountFilter"));
      switchTab("logs");
      renderLogsTable();
    };

    function updateAccountFilterDropdown(pool) {
      const sel = $("logAccountFilter");
      const prev = sel.value || "all";
      let html = '<option value="all">' + esc(tr("全部执行账号", "All Accounts")) + '</option>';
      pool.forEach((s) => {
        const title = (s.label ? (s.label + " (" + s.maskedKey + ")") : s.maskedKey);
        html += '<option value="' + esc(s.slotId) + '">' + esc(title) + '</option>';
      });
      sel.innerHTML = html;
      if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    }

    function renderQuotaCell(poolObj) {
      const rem = poolObj && poolObj.remainingPercent != null ? poolObj.remainingPercent : null;
      if (rem === null) return '<span style="color:var(--fg-faint);" title="' + esc(tr("点击同步最新额度获取", "Click Sync Quotas to fetch")) + '">—</span>';
      const used = Math.max(0, Math.min(100, 100 - rem));
      return '<div class="qbar-cell" title="' + esc(tr("已用 ", "Used ") + used.toFixed(1) + tr("% · 剩余 ", "% · left ") + rem.toFixed(1) + '%') + '">' +
        '<div class="qbar-top"><span class="mono">' + used.toFixed(1) + '%</span><span class="qbar-rem">' + esc(tr("剩余 ", "Left ")) + rem.toFixed(1) + '%</span></div>' +
        '<div class="qbar-track"><div class="qbar-fill" style="width:' + used + '%;background:' + barColor(used) + ';"></div></div>' +
      '</div>';
    }

    function renderBotCell(bot) {
      if (!bot) return '<span style="color:var(--fg-faint);">—</span>';
      if (!bot.hasLimit) return '<span style="color:var(--fg-muted);">' + esc(tr("无 Bot 额度", "No Bot Quota")) + '</span>';
      const rem = bot.remainingPercent;
      return '<div class="bot-stack">' + renderQuotaCell({ remainingPercent: rem }) + (bot.resetAt ? '<div style="font-size:11px;color:var(--fg-muted);margin-top:2px;">' + esc(tr("重置 ", "Resets ")) + esc(new Date(bot.resetAt).toLocaleDateString()) + '</div>' : '') + '</div>';
    }

    function renderStatusDot(slot) {
      if (!slot.enabled) {
        return slot.autoDisabledKind === "auth"
          ? '<span class="status-line" style="color:var(--err);"><span class="dot dot-err"></span>' + esc(tr("鉴权失败·已停用", "Auth Failed · Disabled")) + '</span>'
          : slot.autoDisabledKind === "quota"
          ? '<span class="status-line" style="color:var(--warn);"><span class="dot dot-err"></span>' + esc(tr("额度耗尽·待恢复", "Exhausted · Waiting Reset")) + '</span>'
          : slot.autoDisabledReason
          ? '<span class="status-line" style="color:var(--err);"><span class="dot dot-err"></span>' + esc(tr("自动熔断", "Auto-Tripped")) + '</span>'
          : '<span class="status-line" style="color:var(--fg-muted);"><span class="dot dot-off"></span>' + esc(tr("备用停用", "Standby")) + '</span>';
      }
      if (slot.cooldownRemainingMs > 0) {
        return '<span class="status-line" style="color:var(--warn);"><span class="dot dot-warn"></span>' + esc(tr("冷却 ", "Cooldown ")) + Math.ceil(slot.cooldownRemainingMs / 1000) + 's</span>';
      }
      return '<span class="status-line"><span class="dot dot-ok"></span>' + esc(tr("在线负载", "Active")) + '</span>';
    }

    // ==================== OVERVIEW (ledger-backed charts) ====================
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
    const savedOvRange = lsGet("aq_ov_range");
    let ovRange = (savedOvRange === "today" || savedOvRange === "7d" || savedOvRange === "30d") ? savedOvRange : "today";
    if (ovRange !== "today") {
      document.querySelectorAll("#ovRangeSeg button").forEach((b) => b.classList.toggle("active", b.getAttribute("data-arg") === ovRange));
    }
    let ovDistMode = "model";
    const OV_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4", "#84cc16", "#8e8e96"];

    function ovEmpty(msg) { return '<div class="ov-empty">' + esc(msg || tr("暂无数据", "No data")) + '</div>'; }

    function showOvTip(ev, html) {
      const tip = $("ovTip");
      if (!tip) return;
      tip.innerHTML = html;
      tip.classList.add("show");
      const pad = 14;
      const w = tip.offsetWidth || 180, h = tip.offsetHeight || 70;
      const left = Math.min(window.innerWidth - w - pad, ev.clientX + 14);
      const top = Math.max(pad, ev.clientY - h - 10);
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }
    function hideOvTip() {
      const tip = $("ovTip");
      if (tip) tip.classList.remove("show");
    }

    function ovDonut(rows) {
      const total = rows.reduce((a, r) => a + r.totalTokens, 0);
      if (!rows.length || total <= 0) return ovEmpty(tr("该时间段内暂无调用", "No requests in this range"));
      const S = 156, CX = 78, CY = 78, R = 57, C = 2 * Math.PI * R;
      const gap = rows.length > 1 ? 2.2 : 0;
      let off = 0;
      const arcs = rows.map((r, i) => {
        const fullLen = (r.totalTokens / total) * C;
        const drawLen = Math.max(1.5, fullLen - gap);
        const color = OV_COLORS[i % OV_COLORS.length];
        const el = '<circle class="ov-donut-arc" data-idx="' + i + '" cx="' + CX + '" cy="' + CY + '" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="20" stroke-dasharray="' + drawLen.toFixed(2) + ' ' + (C - drawLen).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 ' + CX + ' ' + CY + ')"/>';
        off += fullLen;
        return el;
      }).join("");
      const legend = rows.map((r, i) => {
        const pct = (r.totalTokens / total * 100).toFixed(1) + "%";
        const color = OV_COLORS[i % OV_COLORS.length];
        return '<div class="ov-dl-row" data-idx="' + i + '">' +
          '<span class="ov-sw" style="background:' + color + '"></span>' +
          '<span class="ov-dl-nm mono" title="' + esc(r.name) + '">' + esc(r.name) + '</span>' +
          '<span class="ov-dl-req">' + fmt(r.requests) + tr(" 次", " reqs") + '</span>' +
          '<span class="ov-dl-tok mono">' + fmtTok(r.totalTokens) + ' · ' + pct + '</span>' +
          '</div>';
      }).join("");
      return '<div class="ov-donut-wrap">' +
        '<svg width="' + S + '" height="' + S + '" viewBox="0 0 ' + S + ' ' + S + '">' +
        '<circle cx="' + CX + '" cy="' + CY + '" r="' + R + '" fill="none" stroke="var(--subtle)" stroke-width="20"/>' +
        arcs +
        '<text id="ovDonutVal" x="' + CX + '" y="' + (CY - 2) + '" text-anchor="middle" font-size="16" font-weight="600" fill="var(--fg)">' + esc(fmtTok(total)) + '</text>' +
        '<text id="ovDonutSub" x="' + CX + '" y="' + (CY + 16) + '" text-anchor="middle" font-size="10.5" fill="var(--fg-muted)">' + esc(tr("总 Tokens", "total tokens")) + '</text>' +
        '</svg>' +
        '<div class="ov-donut-legend">' + legend + '</div></div>';
    }

    function bindOvDonutHover(rows) {
      const box = $("ovDonut");
      if (!box || !rows.length) return;
      const total = rows.reduce((a, r) => a + r.totalTokens, 0);
      if (total <= 0) return;
      const arcs = Array.from(box.querySelectorAll(".ov-donut-arc"));
      const items = Array.from(box.querySelectorAll(".ov-dl-row"));
      const valEl = $("ovDonutVal"), subEl = $("ovDonutSub");
      const activate = (idx, ev) => {
        arcs.forEach((a, i) => {
          a.style.opacity = i === idx ? "1" : "0.28";
          a.setAttribute("stroke-width", i === idx ? "24" : "20");
        });
        items.forEach((it, i) => {
          it.classList.toggle("is-hot", i === idx);
          it.style.opacity = i === idx ? "1" : "0.55";
        });
        const r = rows[idx];
        const pct = (r.totalTokens / total * 100).toFixed(1) + "%";
        if (valEl) valEl.textContent = fmtTok(r.totalTokens);
        if (subEl) subEl.textContent = pct;
        if (ev) {
          const color = OV_COLORS[idx % OV_COLORS.length];
          showOvTip(ev,
            '<div class="ov-tip-hdr mono"><span class="ov-sw" style="display:inline-block;background:' + color + ';margin-right:6px;"></span>' + esc(r.name) + '</div>' +
            '<div class="ov-tip-row"><span class="ov-tip-k">Tokens</span><span>' + fmt(r.totalTokens) + ' (' + pct + ')</span></div>' +
            '<div class="ov-tip-row"><span class="ov-tip-k">' + tr("请求数", "Requests") + '</span><span>' + fmt(r.requests) + '</span></div>'
          );
        }
      };
      const reset = () => {
        arcs.forEach((a) => { a.style.opacity = "1"; a.setAttribute("stroke-width", "20"); });
        items.forEach((it) => { it.classList.remove("is-hot"); it.style.opacity = "1"; });
        if (valEl) valEl.textContent = fmtTok(total);
        if (subEl) subEl.textContent = tr("总 Tokens", "total tokens");
        hideOvTip();
      };
      arcs.concat(items).forEach((el) => {
        const idx = Number(el.getAttribute("data-idx"));
        el.addEventListener("mouseenter", (ev) => activate(idx, ev));
        el.addEventListener("mousemove", (ev) => activate(idx, ev));
        el.addEventListener("mouseleave", reset);
      });
    }

    function ovTrendLabel(t, hours) {
      const d = new Date(t), p = (n) => String(n).padStart(2, "0");
      if (hours === 1) return p(d.getHours()) + ":00";
      if (hours === 6) return p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + "h";
      return p(d.getMonth() + 1) + "/" + p(d.getDate());
    }

    function ovTrend(points, hours) {
      const sum = points.reduce((a, q) => a + q.inputTokens + q.cacheReadTokens + q.outputTokens, 0);
      if (!points.length || sum <= 0) return ovEmpty(tr("该时间段内暂无调用", "No requests in this range"));
      const W = 600, H = 200, L = 66, B = 24, T = 10, Rm = 24;
      const series = [
        { k: "inputTokens", c: "#3b82f6", n: tr("输入", "Input") },
        { k: "cacheReadTokens", c: "#10b981", n: tr("缓存读取", "Cache Read") },
        { k: "outputTokens", c: "#f59e0b", n: tr("输出", "Output") }
      ];
      const max = Math.max(1, ...points.map((q) => Math.max(q.inputTokens, q.cacheReadTokens, q.outputTokens)));
      const x = (i) => L + (points.length === 1 ? (W - L - Rm) / 2 : (i / (points.length - 1)) * (W - L - Rm));
      const y = (v) => T + (1 - v / max) * (H - T - B);
      let grid = "";
      for (let g = 0; g <= 3; g++) {
        const v = (max * g) / 3, yy = y(v);
        grid += '<line x1="' + L + '" x2="' + (W - Rm) + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '" stroke="var(--border)" stroke-width="1"' + (g > 0 ? ' stroke-dasharray="3 3"' : '') + '/>' +
          '<text x="' + (L - 8) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10.5" fill="var(--fg-muted)">' + esc(fmtTok(Math.round(v))) + '</text>';
      }
      const step = Math.max(1, Math.ceil(points.length / 6));
      let xl = "";
      points.forEach((q, i) => {
        if (i % step === 0 || i === points.length - 1) {
          if (i !== points.length - 1 && points.length - 1 - i < step * 0.45) return;
          xl += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10.5" fill="var(--fg-muted)">' + esc(ovTrendLabel(q.t, hours)) + '</text>';
        }
      });
      const baseY = y(0).toFixed(1);
      const lines = series.map((sr, si) => {
        const coords = points.map((q, i) => [x(i).toFixed(1), y(q[sr.k]).toFixed(1)]);
        const pts = coords.map((c) => c[0] + "," + c[1]).join(" ");
        const area = si < 2
          ? '<polygon points="' + coords[0][0] + ',' + baseY + ' ' + pts + ' ' + coords[coords.length - 1][0] + ',' + baseY + '" fill="' + sr.c + '" fill-opacity="0.07"/>'
          : '';
        return area + '<polyline points="' + pts + '" fill="none" stroke="' + sr.c + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      }).join("");
      const hoverLayer = '<line id="ovTrendGuide" x1="0" x2="0" y1="' + T + '" y2="' + baseY + '" stroke="var(--fg-muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>' +
        series.map((sr, si) => '<circle id="ovTrendDot' + si + '" cx="0" cy="0" r="4" fill="' + sr.c + '" stroke="var(--panel)" stroke-width="1.5" style="display:none"/>').join("") +
        '<rect id="ovTrendHit" x="' + L + '" y="' + T + '" width="' + (W - L - Rm) + '" height="' + (H - T - B) + '" fill="transparent" style="cursor:crosshair"/>';
      $("ovTrendLegend").innerHTML = series.map((sr) => '<span><span class="ov-sw" style="display:inline-block;background:' + sr.c + ';margin-right:4px;"></span>' + sr.n + '</span>').join("");
      return '<svg viewBox="0 0 ' + W + ' ' + H + '">' + grid + xl + lines + hoverLayer + '</svg>';
    }

    function bindOvTrendHover(points, hours) {
      const hit = $("ovTrendHit");
      const svg = hit && hit.ownerSVGElement;
      if (!hit || !svg || !points.length) return;
      const W = 600, H = 200, L = 66, B = 24, T = 10, Rm = 24;
      const max = Math.max(1, ...points.map((q) => Math.max(q.inputTokens, q.cacheReadTokens, q.outputTokens)));
      const xAt = (i) => L + (points.length === 1 ? (W - L - Rm) / 2 : (i / (points.length - 1)) * (W - L - Rm));
      const yAt = (v) => T + (1 - v / max) * (H - T - B);
      const series = [
        { k: "inputTokens", c: "#3b82f6", n: tr("输入", "Input") },
        { k: "cacheReadTokens", c: "#10b981", n: tr("缓存读取", "Cache Read") },
        { k: "outputTokens", c: "#f59e0b", n: tr("输出", "Output") }
      ];
      const guide = $("ovTrendGuide");
      const dots = series.map((_, i) => $("ovTrendDot" + i));
      const onMove = (ev) => {
        const rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        const svgX = ((ev.clientX - rect.left) / rect.width) * W;
        const ratio = Math.max(0, Math.min(1, (svgX - L) / (W - L - Rm)));
        const idx = points.length === 1 ? 0 : Math.round(ratio * (points.length - 1));
        const q = points[idx];
        const px = xAt(idx).toFixed(1);
        if (guide) { guide.setAttribute("x1", px); guide.setAttribute("x2", px); guide.style.display = ""; }
        dots.forEach((d, si) => {
          if (!d) return;
          d.setAttribute("cx", px);
          d.setAttribute("cy", yAt(q[series[si].k]).toFixed(1));
          d.style.display = "";
        });
        showOvTip(ev,
          '<div class="ov-tip-hdr mono">' + esc(ovTrendLabel(q.t, hours)) + '</div>' +
          series.map((sr) =>
            '<div class="ov-tip-row"><span class="ov-tip-k"><span class="ov-sw" style="background:' + sr.c + '"></span>' + sr.n + '</span><span>' + fmtTok(q[sr.k]) + '</span></div>'
          ).join("")
        );
      };
      const onLeave = () => {
        if (guide) guide.style.display = "none";
        dots.forEach((d) => { if (d) d.style.display = "none"; });
        hideOvTip();
      };
      hit.addEventListener("mouseenter", onMove);
      hit.addEventListener("mousemove", onMove);
      hit.addEventListener("mouseleave", onLeave);
    }


    let ovRecentCache = [];
    function fillOvFilter(id, label, values) {
      const sel = $(id), cur = sel.value;
      sel.innerHTML = '<option value="">' + esc(label) + '</option>' +
        values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join("");
      sel.value = values.includes(cur) ? cur : "";
      syncSelectUi(sel);
    }
    window.renderOvRecent = () => {
      const ip = $("ovFilterIp").value, key = $("ovFilterKey").value, cl = $("ovFilterClient").value;
      const matched = ovRecentCache.filter((r) => (!ip || r.ip === ip) && (!key || r.key === key) && (!cl || (r.client || "unknown") === cl));
      const shown = matched.slice(0, 10);
      if ($("ovRecentSub")) {
        $("ovRecentSub").textContent = matched.length > 10
          ? tr("仅元数据，当前展示前 10 条（共 " + matched.length + " 条）", "Metadata only · showing latest 10 of " + matched.length)
          : tr("仅元数据，默认展示最近 10 条（不保存任何对话内容）", "Metadata only · latest 10 requests (no conversation text stored)");
      }
      $("ovRecentBody").innerHTML = ovRecent(shown, ovRecentCache.length > 0);
    };

    function ovRecent(rows, hasAny) {
      if (!rows.length) return '<tr><td colspan="8" style="text-align:center;color:var(--fg-muted);padding:24px;">' + (hasAny ? tr("当前筛选条件下无请求", "No matching requests") : tr("暂无请求记录", "No request records yet")) + '</td></tr>';
      return rows.map((r) => {
        const d = new Date(r.at), p = (n) => String(n).padStart(2, "0");
        const when = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
        const st = r.ok
          ? '<span class="status-line"><span class="dot dot-ok"></span>' + r.status + '</span>'
          : '<span class="status-line" style="color:var(--err);"><span class="dot dot-err"></span>' + r.status + '</span>';
        const routedBadgeHtml = (rm) => {
          if (!rm) return "";
          const clean = String(rm).replace(/^us\.anthropic\./, "");
          const low = clean.toLowerCase();
          const cls = low.includes("opus") ? "routed-opus" : low.includes("sonnet") ? "routed-sonnet" : low.includes("haiku") ? "routed-haiku" : "routed-other";
          return '<span class="routed-pill ' + cls + '">→ ' + esc(clean) + '</span>';
        };
        const routedHtml = routedBadgeHtml(r.routedModel);
        const protoSub = (r.protocol ? esc(r.protocol) : '') + (r.stream ? ' · SSE' : ' · JSON');
        const modeBadge = r.execMode === "warm_incremental"
          ? '<span class="tag tag-info" style="font-size:10.5px;">' + esc(tr("增量复用", "Incremental")) + '</span>'
          : r.execMode === "incognito"
            ? '<span class="tag tag-ok" style="font-size:10.5px;">' + esc(tr("无痕隐私", "Incognito")) + '</span>'
            : r.execMode === "cloud"
              ? '<span class="tag" style="font-size:10.5px;color:var(--warn);">' + esc(tr("云端留存", "Cloud Saved")) + '</span>'
              : '';
        const ttft = r.ttftMs != null ? (r.ttftMs / 1000).toFixed(2) + 's' : '—';
        const dur = (r.durationMs / 1000).toFixed(2) + 's';
        return '<tr><td class="mono" style="white-space:nowrap;">' + when + '</td>' +
          '<td>' + st + '</td>' +
          '<td><div class="mono" style="font-weight:500;">' + esc(r.model) + routedHtml + '</div><div style="font-size:11px;color:var(--fg-muted);">' + protoSub + '</div></td>' +
          '<td><div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;"><span>' + esc(r.account) + '</span>' + modeBadge + '</div></td>' +
          '<td>' + esc(r.key) + '</td>' +
          '<td title="' + esc(r.ua || "") + '"><div>' + esc(r.client || "unknown") + '</div><div class="mono" style="font-size:11px;color:var(--fg-muted);">' + esc(r.ip) + '</div></td>' +
          '<td class="mono" style="white-space:nowrap;">' + ttft + ' / ' + dur + '</td>' +
          '<td class="mono" style="white-space:nowrap;">' + fmtTok(r.inputTokens) + ' / <span style="color:var(--ok);">' + fmtTok(r.cacheReadTokens) + '</span> / ' + fmtTok(r.outputTokens) + '</td></tr>';
      }).join("");
    }

    function renderOvDist(o) {
      const data = o || lastOverviewData || {};
      const rows = ovDistMode === "routed"
        ? (data.byRoutedModel || [])
        : ovDistMode === "account"
          ? (data.byAccount || [])
          : ovDistMode === "key"
            ? (data.byKey || [])
            : (data.byModel || []);
      if ($("ovDistTitle")) {
        $("ovDistTitle").textContent = ovDistMode === "routed"
          ? tr("实际路由模型分布（按 Token）", "Routed Model Share (Tokens)")
          : ovDistMode === "account"
            ? tr("账号分布（按 Token）", "Account Share (Tokens)")
            : ovDistMode === "key"
              ? tr("子密钥分布（按 Token）", "Sub-Key Share (Tokens)")
              : tr("模型分布（按 Token）", "Model Share (Tokens)");
      }
      if (ovDistMode === "routed" && !rows.length) {
        $("ovDonut").innerHTML = '<div style="font-size:12px;color:var(--fg-muted);padding:32px 12px;text-align:center;">' + esc(tr("暂无实际路由模型记录（新请求完成后将自动统计各底层模型占比）", "No routed model stats yet (populated on new requests)")) + '</div>';
        return;
      }
      $("ovDonut").innerHTML = ovDonut(rows);
      bindOvDonutHover(rows);
    }
    window.setOvDist = (mode) => {
      ovDistMode = mode || "model";
      document.querySelectorAll("#ovDistSeg button").forEach((b) => b.classList.toggle("active", b.dataset.arg === ovDistMode));
      renderOvDist(lastOverviewData);
    };

    function renderOverview(o) {
      lastOverviewData = o;
      const t = o.totals || {};
      $("ovReq").textContent = fmt(t.requests);
      $("ovErrTag").textContent = tr("错误 ", "Errors ") + fmt(t.errors);
      $("ovReqSub").textContent = t.requests ? (tr("成功率 ", "Success Rate ") + ((1 - t.errors / t.requests) * 100).toFixed(1) + "%") : tr("成功率 —", "Success Rate —");
      $("ovTok").innerHTML = tokSpan(t.totalTokens);
      $("ovTokSub").textContent = tr("输入 ", "In ") + fmtTok(t.inputTokens) + tr(" · 缓存 ", " · Cache ") + fmtTok(t.cacheReadTokens) + tr(" · 输出 ", " · Out ") + fmtTok(t.outputTokens);
      $("ovCache").textContent = (t.cacheHitRatePercent || 0) + "%";
      renderOvDist(o);
      $("ovTrend").innerHTML = ovTrend(o.trend || [], o.bucketHours || 1);
      bindOvTrendHover(o.trend || [], o.bucketHours || 1);
      ovRecentCache = o.recent || [];
      fillOvFilter("ovFilterIp", tr("全部 IP", "All IPs"), [...new Set(ovRecentCache.map((r) => r.ip))]);
      fillOvFilter("ovFilterClient", tr("全部客户端", "All Clients"), [...new Set(ovRecentCache.map((r) => r.client || "unknown"))]);
      fillOvFilter("ovFilterKey", tr("全部子密钥", "All Sub-Keys"), [...new Set(ovRecentCache.map((r) => r.key))]);
      window.renderOvRecent();
    }

    async function loadOverview() {
      try {
        const o = await api("/v1/admin/overview?range=" + ovRange);
        renderOverview(o);
      } catch (e) {
        if ($("appShell").style.display !== "none") notify(e.message, true);
      }
    }

    window.setOvRange = (r) => {
      ovRange = r;
      lsSet("aq_ov_range", r);
      document.querySelectorAll("#ovRangeSeg button").forEach((b) => b.classList.toggle("active", b.getAttribute("data-arg") === r));
      void loadOverview();
    };

    const shortPlan = (raw) => {
      const s = String(raw || "").toUpperCase();
      if (!s || s === "—") return "";
      if (s === "QUICK_LITE_FREE_TRIAL") return "FREE TRIAL";
      if (s.startsWith("QUICK_")) return s.replace(/^QUICK_/, "").replace(/_/g, " ");
      return s;
    };
    const renderAuthTag = (s) => {
      const t = s.authType || (String(s.maskedKey || "").startsWith("oauth:") ? "oauth" : String(s.maskedKey || "").startsWith("web:") ? "cookie" : "outpost");
      if (t === "oauth") return '<span class="tag" style="background:var(--subtle);color:var(--fg);border-color:var(--border-strong);">' + esc(tr("OAuth 90天", "OAuth 90d")) + '</span>';
      if (t === "cookie") return '<span class="tag tag-warn">Cookie</span>';
      return '<span class="tag">' + esc(tr("本机桌面", "Desktop")) + '</span>';
    };
    const cleanMonthlyText = (raw) => String(raw || "").replace(/^Monthly\s+/i, "");
    const fmtHmDur = (mins) => {
      const m = Math.max(1, Math.round(mins));
      const h = Math.floor(m / 60);
      const rem = m % 60;
      if (h > 0 && rem > 0) return h + "h " + rem + "m";
      if (h > 0) return h + "h";
      return rem + "m";
    };
    const fmtClockHm = (isoOrMs) => {
      const d = new Date(isoOrMs);
      if (Number.isNaN(d.getTime())) return "";
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    };
    const formatShortDisableReason = (reason, kind, autoRecoverAt) => {
      const r = String(reason || "");
      const recMs = autoRecoverAt ? Date.parse(autoRecoverAt) : NaN;
      const isShortRecover = Number.isFinite(recMs) && recMs > Date.now() && (recMs - Date.now()) <= 24 * 3600 * 1000;
      const recClock = isShortRecover ? fmtClockHm(recMs) : "";
      if (/Monthly 10h pool/i.test(r)) return tr("月度 10h 额度已满", "Monthly 10h pool exhausted");
      if (/Session burst pool/i.test(r)) return recClock ? tr("短时已满 · " + recClock + " 自动恢复", "5h full · auto " + recClock) : tr("短时窗口已满 · 待恢复", "5h burst exhausted · waiting");
      if (/usage limit|quota[_ ]exhausted/i.test(r) || kind === "quota") return recClock ? tr("限额熔断 · " + recClock + " 自动恢复", "Limit tripped · auto " + recClock) : tr("触发限额熔断 · 待恢复", "Usage limit tripped · waiting");
      if (kind === "auth" || /auth/i.test(r)) return tr("认证失效 · 请重新授权", "Auth expired · re-authorize");
      return r.length > 28 ? (r.slice(0, 28) + "…") : r;
    };
    const buildAccountInfoHtml = (s) => {
      const q = s.quota || {};
      const idt = s.identity || {};
      const hasQuota = Boolean(q.premiumApiPool && q.premiumApiPool.usedPercent != null);
      const realEmail = idt.userEmail && idt.userEmail.includes("@") ? idt.userEmail : "";
      const title = s.label || realEmail || idt.userEmail || ("Account #" + (s.slotId || "").slice(0, 4));
      const subParts = [];
      if (realEmail && realEmail !== title) subParts.push(realEmail);
      if (idt.displayName) subParts.push(idt.displayName);
      if (!subParts.length && !hasQuota && !realEmail) subParts.push(tr("等待同步账号信息", "Pending sync"));
      const planStr = shortPlan(q.membershipType);
      const shortAgentId = s.chatAgentId
        ? (s.chatAgentId.length > 16 ? (s.chatAgentId.slice(0, 8) + "…" + s.chatAgentId.slice(-4)) : s.chatAgentId)
        : "";
      return '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
          '<span style="font-weight:600;">' + esc(title) + '</span>' +
          renderAuthTag(s) +
          (planStr ? '<span class="tag">' + esc(planStr) + '</span>' : '') +
        '</div>' +
        (subParts.length ? '<div style="color:var(--fg-muted);font-size:11.5px;margin-top:2px;">' + esc(subParts.join(" · ")) + '</div>' : '') +
        (s.maskedProxy ? '<div class="mono" style="font-size:10.5px;color:var(--ok);margin-top:2px;">Proxy: ' + esc(s.maskedProxy) + '</div>' : '') +
        (shortAgentId ? '<div class="mono" style="font-size:10.5px;color:var(--fg-muted);margin-top:2px;" title="Agent: ' + esc(s.chatAgentId) + '">Agent: ' + esc(shortAgentId) + '</div>' : '');
    };
    const buildCompactQuotaHtml = (s, isSyncing) => {
      if (isSyncing) {
        return '<div style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--fg-muted);"><span class="inline-spin"></span><span>' + esc(tr("正在同步额度...", "Syncing quota...")) + '</span></div>';
      }
      const q = s.quota || {};
      const hasQuota = Boolean(q.premiumApiPool && q.premiumApiPool.usedPercent != null);
      if (!hasQuota) {
        if (s.lastSyncError) {
          return '<div style="font-size:11.5px;color:var(--err);font-weight:500;">' + esc(tr("同步失败", "Sync failed")) + '</div>' +
            '<div style="font-size:10.5px;color:var(--err);margin-top:2px;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(s.lastSyncError) + '">' + esc(s.lastSyncError) + '</div>';
        }
        return '<div style="font-size:11.5px;color:var(--fg-muted);">' + esc(tr("未同步", "Not synced")) + '</div>' +
          '<div style="font-size:10.5px;color:var(--fg-muted);margin-top:2px;">' + esc(tr("点击该行「刷新额度」", "Click Sync Quota on this row")) + '</div>';
      }
      const resetStr = q.daysRemainingInCycle != null ? (q.daysRemainingInCycle + tr("天重置", "d reset")) : "";
      const trialStr = q.trialDaysRemaining != null ? (tr("试用 ", "Trial ") + q.trialDaysRemaining + tr("天", "d")) : "";
      const rawMonthlyUsed = q.premiumApiPool && q.premiumApiPool.usedPercent != null ? Number(q.premiumApiPool.usedPercent) : null;
      const monthlyUsedNum = rawMonthlyUsed != null && Number.isFinite(rawMonthlyUsed) ? rawMonthlyUsed : null;
      const monthlyBarColor = monthlyUsedNum == null ? "var(--ok)" : monthlyUsedNum >= 90 ? "var(--err)" : monthlyUsedNum >= 75 ? "var(--warn)" : "var(--ok)";
      const monthlyDetail = [cleanMonthlyText(q.apiDisplayMessage), resetStr].filter(Boolean).join(" · ");
      const sessUsedNum = q.sessionPool && q.sessionPool.usedPercent != null ? Number(q.sessionPool.usedPercent) : null;
      const sessPct = sessUsedNum != null && Number.isFinite(sessUsedNum) ? (Math.round(sessUsedNum) + "%") : "";
      const sessBarColor = sessUsedNum == null ? "var(--ok)" : sessUsedNum >= 95 ? "var(--err)" : sessUsedNum >= 80 ? "var(--warn)" : "var(--ok)";
      const sessResumeAtMs = q.sessionPool && q.sessionPool.resumeAt ? Date.parse(q.sessionPool.resumeAt) : NaN;
      const sessRemainMin = Number.isFinite(sessResumeAtMs)
        ? Math.max(0, Math.ceil((sessResumeAtMs - Date.now()) / 60000))
        : (q.sessionPool && typeof q.sessionPool.resumeInMinutes === "number" && q.sessionPool.resumeInMinutes > 0
            ? Math.ceil(q.sessionPool.resumeInMinutes)
            : 0);
      const sessResumeClock = sessRemainMin > 0
        ? fmtClockHm(Number.isFinite(sessResumeAtMs) ? sessResumeAtMs : (Date.now() + sessRemainMin * 60000))
        : "";
      const sessResumeShort = sessRemainMin > 0
        ? (fmtHmDur(sessRemainMin) + tr("后", "") + (sessResumeClock ? (" · " + sessResumeClock) : ""))
        : "";
      const sessResumeTitle = sessRemainMin > 0
        ? [tr("预计 ", "Resumes ~") + (sessResumeClock || "") + tr(" 恢复（约 ", " (in ") + fmtHmDur(sessRemainMin) + tr(" 后）", ")"), trialStr].filter(Boolean).join(" · ")
        : trialStr;
      return '<div style="min-width:175px;max-width:215px;">' +
          '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;margin-bottom:3px;">' +
            '<span style="font-weight:600;color:' + (monthlyUsedNum != null && monthlyUsedNum >= 90 ? 'var(--err)' : 'var(--fg)') + ';white-space:nowrap;">' + esc(tr("月度 ", "Monthly ") + (monthlyUsedNum != null ? monthlyUsedNum.toFixed(1) + "%" : "—")) + '</span>' +
            (monthlyDetail ? '<span style="font-size:10px;color:var(--fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(monthlyDetail) + '">' + esc(monthlyDetail) + '</span>' : '') +
          '</div>' +
          '<div style="height:4px;border-radius:999px;background:var(--track);overflow:hidden;">' +
            '<div style="height:100%;width:' + Math.max(0, Math.min(100, monthlyUsedNum || 0)) + '%;background:' + monthlyBarColor + ';border-radius:999px;"></div>' +
          '</div>' +
          (sessUsedNum != null && Number.isFinite(sessUsedNum)
            ? '<div style="margin-top:6px;">' +
                '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;margin-bottom:3px;">' +
                  '<span style="color:' + (sessUsedNum >= 80 ? sessBarColor : 'var(--fg-muted)') + ';font-weight:' + (sessUsedNum >= 80 ? '600' : '500') + ';white-space:nowrap;">' + esc(tr("短时 ", "5h Burst ") + sessPct) + '</span>' +
                  (sessResumeShort
                    ? '<span style="font-size:10px;color:' + (sessUsedNum >= 95 ? 'var(--err)' : 'var(--warn)') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(sessResumeTitle) + '">' + esc(sessResumeShort) + '</span>'
                    : (trialStr ? '<span style="font-size:10px;color:var(--fg-muted);white-space:nowrap;">' + esc(trialStr) + '</span>' : '')) +
                '</div>' +
                '<div style="height:4px;border-radius:999px;background:var(--track);overflow:hidden;">' +
                  '<div style="height:100%;width:' + Math.max(0, Math.min(100, sessUsedNum)) + '%;background:' + sessBarColor + ';border-radius:999px;"></div>' +
                '</div>' +
              '</div>'
            : (trialStr ? '<div style="font-size:10px;color:var(--fg-muted);margin-top:4px;">' + esc(trialStr) + '</div>' : '')) +
        '</div>' +
        (s.lastSyncError ? '<div style="font-size:10.5px;color:var(--err);margin-top:3px;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(s.lastSyncError) + '">' + esc(tr("最近同步失败: ", "Sync failed: ") + s.lastSyncError) + '</div>' : '');
    };

    function renderAll(data) {
      lastConsoleData = data;
      const pool = data.keyPool || [];
      poolSlotsCache = pool;
      updateAccountFilterDropdown(pool);

      const usage = data.gatewaySessionUsage || data;
      const settings = data.settings || {};
      const affinities = data.affinities || [];
      const tot = usage.totals || {};

      const enabledCount = pool.filter((s) => s.enabled).length;
      if ($("onboardBanner")) $("onboardBanner").classList.toggle("show", pool.length === 0);
      const autoTripped = pool.filter((s) => !s.enabled && s.autoDisabledReason).length;
      const inflight = pool.reduce((a, s) => a + (s.activeInflight || 0), 0);

      $("mStrategyTag").textContent = settings.lbStrategy || "quota-aware";
      $("mActiveKeys").textContent = enabledCount + " / " + pool.length;
      $("mInflightSub").textContent = tr("活跃并发流: ", "In-flight: ") + inflight + tr(" · 自动熔断: ", " · Auto-tripped: ") + autoTripped;

      const onlinePool = pool.filter((s) => s.enabled).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      const ovLimit = 3;
      const sortedOvPool = onlinePool.slice(0, ovLimit);
      $("overviewAccountsBody").innerHTML = sortedOvPool.length ? (sortedOvPool.map((s) => {
        const isSyncing = busySyncIds.has(s.slotId);
        const rowCls = ['clickable-row', isSyncing ? 'row-busy' : ''].filter(Boolean).join(' ');
        return '<tr class="' + rowCls + '" data-click="jumpToAccountLogs" data-arg="' + esc(s.slotId) + '" title="' + esc(tr("点击筛选查看该账号的请求日志", "Click to filter request logs for this account")) + '">' +
          '<td style="min-width:130px;">' +
            '<div>' + renderStatusDot(s) + '</div>' +
            (s.autoDisabledReason ? '<div style="font-size:10.5px;color:' + (s.autoDisabledKind === 'quota' ? 'var(--warn)' : 'var(--err)') + ';margin-top:3px;max-width:165px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(s.autoDisabledReason) + '">' + esc(formatShortDisableReason(s.autoDisabledReason, s.autoDisabledKind, s.autoRecoverAt)) + '</div>' : '') +
          '</td>' +
          '<td title="' + esc(tr("凭证指纹: ", "Key: ") + s.maskedKey) + '">' + buildAccountInfoHtml(s) + '</td>' +
          '<td>' + buildCompactQuotaHtml(s, isSyncing) + '</td>' +
          '<td class="mono" style="font-size:11.5px;">' +
            '<div>' + esc(tr('调度 ', 'Req ') + fmt(s.totalSelected) + ' · 429: ' + fmt(s.rateLimitHits) + ' · ' + tr('会话 ', 'Sess ') + (typeof s.cloudSessionCount === 'number' ? s.cloudSessionCount : '—')) + '</div>' +
            '<div style="color:var(--fg-muted);font-size:11px;margin-top:2px;">' + esc(tr('粘性 ', 'Sticky ') + fmt(s.stickySessions) + tr(' · 命中 ', ' · Hits ') + fmt(s.affinityHits)) + '</div>' +
          '</td>' +
        '</tr>';
      }).join("") + (onlinePool.length > ovLimit
        ? '<tr><td colspan="4" style="text-align:center;color:var(--fg-muted);font-size:11.5px;padding:10px;">' + esc(tr("仅展示前 " + ovLimit + " 个在线账号（共 " + onlinePool.length + " 个在线），点击右上角「管理凭证 →」查看全部", "Showing top " + ovLimit + " of " + onlinePool.length + " online accounts · click Manage Credentials for all")) + '</td></tr>'
        : '')) : '<tr><td colspan="4" style="text-align:center;color:var(--fg-muted);padding:24px;">' + esc(pool.length ? tr("当前无在线凭证（可在「凭证与额度池」中查看或恢复）", "No online credentials (check Credentials)") : tr("暂无凭证", "No credentials")) + '</td></tr>';

      renderCredTable();

      if (settings.lbStrategy) { $("cfgLbStrategy").value = settings.lbStrategy; syncSelectUi($("cfgLbStrategy")); }
      $("cfgAffinityEnabled").checked = settings.sessionAffinityEnabled !== false;
      $("cfgAffinityTtl").value = settings.sessionAffinityTtlSeconds || 3600;
      $("cfgAutoDisable").checked = settings.autoDisableExhaustedKeys !== false;
      if ($("cfgIncognitoMode")) $("cfgIncognitoMode").checked = settings.incognitoMode !== false;
      if ($("cfgAutoEnsureCodingAgent")) $("cfgAutoEnsureCodingAgent").checked = settings.autoEnsureCodingAgent !== false;
      window.__defaultCustomAgentPrompt = settings.defaultCustomAgentPrompt || "";
      window.__activeCustomAgentPrompt = settings.customAgentPrompt || settings.defaultCustomAgentPrompt || "";
      if ($("cfgCustomAgentPrompt")) {
        $("cfgCustomAgentPrompt").value = settings.customAgentPrompt || settings.defaultCustomAgentPrompt || "";
      }

      $("affinityTableBody").innerHTML = affinities.length ? affinities.map((a) =>
        '<tr>' +
          '<td class="mono">' + esc(a.conversationKey) + '</td>' +
          '<td class="mono">' + esc(a.maskedKey) + ' <span style="color:var(--fg-muted);">(' + esc(a.slotId) + ')</span></td>' +
          '<td class="mono">' + fmt(a.hitCount) + '</td>' +
          '<td class="mono" style="color:var(--fg-muted);">' + new Date(a.lastHitAt).toLocaleTimeString() + '</td>' +
          '<td class="mono">' + fmt(a.expiresInSeconds) + 's</td>' +
        '</tr>'
      ).join("") : '<tr><td colspan="5" style="text-align:center;color:var(--fg-muted);padding:20px;">' + esc(tr("当前无活跃粘性绑定会话", "No active sticky bindings")) + '</td></tr>';

      $("syncTimeLabel").textContent = tr("更新于 ", "Updated ") + new Date().toLocaleTimeString();
    }

    const selectedCredIds = new Set();
    const busySyncIds = new Set();
    const busyClearIds = new Set();
    function setCredPanelLoading() {
      const box = $("credPanelBox");
      if (!box) return;
      box.classList.toggle("is-loading", busySyncIds.size > 0 || busyClearIds.size > 0);
    }
    function fmtRelTime(ms) {
      if (!ms || !Number.isFinite(ms)) return "—";
      const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (sec < 5) return tr("刚刚", "Just now");
      if (sec < 60) return sec + tr(" 秒前", "s ago");
      const min = Math.floor(sec / 60);
      if (min < 60) return min + tr(" 分钟前", "m ago");
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + tr(" 小时前", "h ago");
      const day = Math.floor(hr / 24);
      return day + tr(" 天前", "d ago");
    }
    function fmtShortDate(ms) {
      if (!ms || !Number.isFinite(ms)) return "";
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
    function getFilteredCreds() {
      const kw = ($("credSearchInput") ? $("credSearchInput").value : "").trim().toLowerCase();
      const st = $("credStatusFilter") ? $("credStatusFilter").value : "all";
      const sortBy = $("credSortFilter") ? $("credSortFilter").value : "newest";
      const list = poolSlotsCache.filter((s) => {
        if (st === "healthy" && !s.healthy) return false;
        if (st === "disabled" && s.enabled) return false;
        if (st === "abnormal" && (s.healthy || (!s.enabled && !s.autoDisabledReason))) return false;
        if (kw) {
          const idt = s.identity || {};
          const hay = ((s.label || "") + " " + (s.maskedKey || "") + " " + (s.maskedProxy || "") + " " + (s.chatAgentId || "") + " " + (idt.userEmail || "") + " " + (idt.displayName || "")).toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      });
      list.sort((a, b) => {
        if (sortBy === "oldest") return (a.addedAt || 0) - (b.addedAt || 0);
        if (sortBy === "quota") {
          const ra = a.quota && a.quota.premiumApiPool && a.quota.premiumApiPool.remainingPercent != null ? a.quota.premiumApiPool.remainingPercent : -1;
          const rb = b.quota && b.quota.premiumApiPool && b.quota.premiumApiPool.remainingPercent != null ? b.quota.premiumApiPool.remainingPercent : -1;
          if (rb !== ra) return rb - ra;
          return (b.addedAt || 0) - (a.addedAt || 0);
        }
        if (sortBy === "requests") {
          const diff = (b.totalSelected || 0) - (a.totalSelected || 0);
          if (diff !== 0) return diff;
          return (b.addedAt || 0) - (a.addedAt || 0);
        }
        return (b.addedAt || 0) - (a.addedAt || 0);
      });
      return list;
    }

    function renderCredTable() {
      const filtered = getFilteredCreds();
      const validIds = new Set(poolSlotsCache.map((s) => s.slotId));
      for (const id of [...selectedCredIds]) { if (!validIds.has(id)) selectedCredIds.delete(id); }
      if ($("credSelSummary")) {
        $("credSelSummary").textContent = tr("已选 ", "") + selectedCredIds.size + tr(" 项（显示 ", " selected (") + filtered.length + "/" + poolSlotsCache.length + tr("）", ")");
      }
      if ($("credSyncQuotaBtn") && !$("credSyncQuotaBtn").disabled) {
        $("credSyncQuotaBtn").textContent = selectedCredIds.size > 0
          ? tr("同步所选 (" + selectedCredIds.size + ")", "Sync Selected (" + selectedCredIds.size + ")")
          : tr("同步最新额度", "Sync Quotas");
      }
      if ($("credBatchRecheckBtn") && !$("credBatchRecheckBtn").disabled) {
        $("credBatchRecheckBtn").textContent = selectedCredIds.size > 0
          ? tr("批量检测 (" + selectedCredIds.size + ")", "Batch Check (" + selectedCredIds.size + ")")
          : tr("批量检测", "Batch Check");
      }
      if ($("credClearSessionsBtn") && !$("credClearSessionsBtn").disabled) {
        $("credClearSessionsBtn").textContent = selectedCredIds.size > 0
          ? tr("清理所选会话 (" + selectedCredIds.size + ")", "Clear Sessions (" + selectedCredIds.size + ")")
          : tr("清理会话", "Clear Sessions");
      }
      if ($("credSelectAllCb")) {
        $("credSelectAllCb").checked = filtered.length > 0 && filtered.every((s) => selectedCredIds.has(s.slotId));
      }
      $("credTableBody").innerHTML = filtered.length ? filtered.map((s) => {
        const checked = selectedCredIds.has(s.slotId) ? "checked" : "";
        const addedTitle = s.addedAt ? new Date(s.addedAt).toLocaleString() : "";
        const isSyncing = busySyncIds.has(s.slotId);
        const isClearing = busyClearIds.has(s.slotId);
        const rowCls = [!s.enabled ? 'row-disabled' : '', (isSyncing || isClearing) ? 'row-busy' : ''].filter(Boolean).join(' ');
        return '<tr class="' + rowCls + '">' +
          '<td><input type="checkbox" ' + checked + ' data-change="toggleCredSelect" data-arg="' + esc(s.slotId) + '" /></td>' +
          '<td><label class="switch"><input type="checkbox" ' + (s.enabled ? 'checked' : '') + ' data-change="toggleKey" data-arg="' + esc(s.slotId) + '" /><span class="slider"></span></label></td>' +
          '<td title="' + esc(tr("凭证指纹: ", "Key: ") + s.maskedKey) + '">' + buildAccountInfoHtml(s) + '</td>' +
          '<td>' + buildCompactQuotaHtml(s, isSyncing) + '</td>' +
          '<td title="' + esc(addedTitle) + '" style="white-space:nowrap;">' +
            '<div style="font-size:12px;font-weight:500;">' + esc(fmtRelTime(s.addedAt)) + '</div>' +
            '<div class="mono" style="font-size:10.5px;color:var(--fg-muted);margin-top:2px;">' + esc(fmtShortDate(s.addedAt)) + '</div>' +
          '</td>' +
          '<td class="run-cell" style="font-size:11.5px;min-width:155px;max-width:200px;">' +
            '<div>' + renderStatusDot(s) + '</div>' +
            '<div style="font-size:11px;color:var(--fg-muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(tr('调度 ', 'Req ') + fmt(s.totalSelected) + ' · 429: ' + fmt(s.rateLimitHits) + ' · ' + tr('会话 ', 'Sess ') + (typeof s.cloudSessionCount === 'number' ? s.cloudSessionCount : '—')) + '">' +
              (isClearing
                ? '<span style="display:inline-flex;align-items:center;gap:5px;"><span class="inline-spin"></span>' + esc(tr('清理会话中...', 'Clearing...')) + '</span>'
                : esc(tr('调度 ', 'Req ') + fmt(s.totalSelected) + ' · 429: ' + fmt(s.rateLimitHits) + ' · ' + tr('会话 ', 'Sess ') + (typeof s.cloudSessionCount === 'number' ? s.cloudSessionCount : '—'))) +
            '</div>' +
            (s.autoDisabledReason ? '<div style="font-size:10.5px;color:' + (s.autoDisabledKind === 'quota' ? 'var(--warn)' : 'var(--err)') + ';margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(s.autoDisabledReason) + '">' + esc(formatShortDisableReason(s.autoDisabledReason, s.autoDisabledKind, s.autoRecoverAt)) + '</div>' : '') +
          '</td>' +
          '<td class="ops-cell"><div class="ops-grid-2">' +
            '<button class="btn-xs" data-click="syncOneQuota" data-arg="' + esc(s.slotId) + '"' + (isSyncing ? ' disabled' : '') + ' title="' + esc(tr('仅刷新该凭证的额度与云端会话数（额度已补充会自动恢复调度）', 'Refresh quota for this credential only (auto re-enables it once quota is back)')) + '">' + esc(isSyncing ? tr('刷新中', 'Syncing') : tr('刷新额度', 'Sync Quota')) + '</button>' +
            '<button class="btn-xs" data-click="jumpToAccountLogs" data-arg="' + esc(s.slotId) + '" title="' + esc(tr('查看该账号的实时请求日志', 'View request logs for this account')) + '">' + esc(tr('请求日志', 'Logs')) + '</button>' +
            '<button class="btn-xs" data-click="editLabel" data-arg="' + esc(s.slotId) + '" data-arg2="' + esc(s.label || '') + '" title="' + esc(tr('修改账号备注名称', 'Edit account label')) + '">' + esc(tr('修改备注', 'Label')) + '</button>' +
            '<button class="btn-xs" data-click="editProxy" data-arg="' + esc(s.slotId) + '" data-arg2="' + esc(s.maskedProxy || '') + '" title="' + esc(tr('配置该账号的独立出口代理', 'Configure per-account proxy')) + '">' + esc(tr('出口代理', 'Proxy')) + '</button>' +
            '<button class="btn-xs" data-click="editChatAgent" data-arg="' + esc(s.slotId) + '" data-arg2="' + esc(s.chatAgentId || '') + '" title="' + esc(tr('绑定或切换该账号的专属智能体 ID', 'Bind custom chat Agent ID')) + '">' + esc(tr('定义智能体', 'Custom Agent')) + '</button>' +
            (s.cooldownRemainingMs > 0 ? '<button class="btn-xs" data-click="clearKeyCd" data-arg="' + esc(s.slotId) + '">' + esc(tr('解封', 'Uncool')) + '</button>' : '') +
          '</div></td>' +
        '</tr>';
      }).join("") : '<tr><td colspan="7" style="text-align:center;color:var(--fg-muted);padding:24px;">' + esc(poolSlotsCache.length ? tr("当前筛选条件下无匹配凭证", "No matching credentials") : tr("暂无凭证", "No credentials")) + '</td></tr>';
    }

    window.toggleCredSelect = (slotId, checked) => {
      if (checked) selectedCredIds.add(slotId);
      else selectedCredIds.delete(slotId);
      renderCredTable();
    };
    if ($("credSelectAllCb")) {
      $("credSelectAllCb").onchange = (ev) => {
        const checked = ev.target.checked;
        getFilteredCreds().forEach((s) => { if (checked) selectedCredIds.add(s.slotId); else selectedCredIds.delete(s.slotId); });
        renderCredTable();
      };
    }
    if ($("credSearchInput")) $("credSearchInput").oninput = renderCredTable;
    const restoreSelectPref = (sel, key) => {
      if (!sel) return;
      const saved = lsGet(key);
      if (saved && Array.from(sel.options || []).some((o) => o.value === saved)) {
        sel.value = saved;
        if (typeof syncSelectUi === "function") syncSelectUi(sel);
      }
    };
    restoreSelectPref($("credStatusFilter"), "aq_cred_status");
    restoreSelectPref($("credSortFilter"), "aq_cred_sort");
    if ($("credStatusFilter")) $("credStatusFilter").onchange = () => {
      lsSet("aq_cred_status", $("credStatusFilter").value);
      renderCredTable();
    };
    if ($("credSortFilter")) $("credSortFilter").onchange = () => {
      lsSet("aq_cred_sort", $("credSortFilter").value);
      renderCredTable();
    };
    if ($("ovManageCredsBtn")) $("ovManageCredsBtn").onclick = () => switchTab("credentials");

    if ($("credBatchImportBtn") && $("credBatchImportFile")) {
      $("credBatchImportBtn").onclick = () => $("credBatchImportFile").click();
      $("credBatchImportFile").onchange = async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const btn = $("credBatchImportBtn");
        btn.disabled = true;
        const origText = btn.textContent;
        btn.textContent = tr("导入中...", "Importing...");
        try {
          const text = await file.text();
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new Error(tr("文件不是有效的 JSON 格式。", "Invalid JSON file."));
          }
          const r = await api("/v1/admin/keys/import-json", { method: "POST", body: JSON.stringify(parsed) });
          notify(tr("已从 JSON 文件批量导入 " + (r.imported || 0) + " 条凭证并同步额度。", "Imported " + (r.imported || 0) + " credential(s) from JSON."));
          await loadConsoleData("?force=1");
        } catch (e) {
          notify(tr("批量导入失败: ", "Batch import failed: ") + e.message, true);
        } finally {
          btn.disabled = false;
          btn.textContent = origText;
          $("credBatchImportFile").value = "";
        }
      };
    }

    if ($("credExportBtn")) {
      $("credExportBtn").onclick = async () => {
        const ids = [...selectedCredIds];
        if (!ids.length) return notify(tr("请先勾选要导出的凭证（可先按状态筛选再全选）。", "Select at least one credential to export."), true);
        try {
          const res = await api("/v1/admin/keys/export", { method: "POST", body: JSON.stringify({ slotIds: ids }) });
          const items = Array.isArray(res.credentials) ? res.credentials : [];
          const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "aws-quick2api-credentials-" + new Date().toISOString().slice(0, 10) + ".json";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          notify(tr("已导出 " + (res.credentials ? res.credentials.length : ids.length) + " 条凭证备份（JSON）。", "Exported " + ids.length + " credential(s)."));
        } catch (e) { notify(e.message, true); }
      };
    }

    async function runCredBatch(action) {
      const ids = [...selectedCredIds];
      if (!ids.length) return notify(tr("请先勾选要批量操作的凭证。", "Select at least one credential first."), true);
      if (action === "delete") {
        const ok = await uiConfirm({
          title: tr("批量移除凭证", "Delete Selected Credentials"),
          desc: tr("确认从网关移除已勾选的 " + ids.length + " 条凭证吗？此操作不可撤销。", "Remove " + ids.length + " selected credential(s) from the pool?"),
          okText: tr("确认移除", "Delete"),
          danger: true
        });
        if (!ok) return;
      }
      try {
        const r = await api("/v1/admin/keys/batch", { method: "POST", body: JSON.stringify({ action, slotIds: ids }) });
        if (action === "delete") ids.forEach((id) => selectedCredIds.delete(id));
        const verb = action === "enable" ? tr("已批量启用 ", "Enabled ") : action === "disable" ? tr("已批量停用 ", "Disabled ") : tr("已批量移除 ", "Removed ");
        notify(verb + (r.affected ?? ids.length) + tr(" 条凭证。", " credential(s)."));
        await loadConsoleData(action === "enable" ? "?force=1" : "");
      } catch (e) { notify(e.message, true); }
    }
    if ($("credBatchEnableBtn")) $("credBatchEnableBtn").onclick = () => void runCredBatch("enable");
    if ($("credBatchDisableBtn")) $("credBatchDisableBtn").onclick = () => void runCredBatch("disable");
    if ($("credBatchDeleteBtn")) $("credBatchDeleteBtn").onclick = () => void runCredBatch("delete");
    if ($("credBatchRecheckBtn")) {
      $("credBatchRecheckBtn").onclick = async () => {
        const abnormalIds = poolSlotsCache.filter((s) => !s.enabled || s.lastSyncError || s.cooldownRemainingMs > 0).map((s) => s.slotId);
        const ids = selectedCredIds.size > 0
          ? [...selectedCredIds]
          : (abnormalIds.length ? abnormalIds : poolSlotsCache.map((s) => s.slotId));
        if (!ids.length) return notify(tr("当前没有可检测的凭证。", "No credentials to check."), true);
        const btn = $("credBatchRecheckBtn");
        btn.disabled = true;
        ids.forEach((id) => busySyncIds.add(id));
        setCredPanelLoading();
        renderCredTable();
        try {
          const r = await api("/v1/admin/keys/batch", { method: "POST", body: JSON.stringify({ action: "recheck", slotIds: ids }) });
          const okCount = r.okCount ?? 0;
          const failedCount = r.failedCount ?? 0;
          notify(
            failedCount > 0
              ? tr("批量检测完成：" + okCount + " 个正常，" + failedCount + " 个异常/停用。", "Checked: " + okCount + " healthy, " + failedCount + " failed.")
              : tr("批量检测完成：" + okCount + " 个账号全部正常。", "Checked: " + okCount + " healthy."),
            failedCount > 0 && okCount === 0
          );
          await loadConsoleData("");
        } catch (e) {
          notify(e.message, true);
        } finally {
          ids.forEach((id) => busySyncIds.delete(id));
          setCredPanelLoading();
          btn.disabled = false;
          renderCredTable();
        }
      };
    }

    function bindSnippetCopy(btnId, preId) {
      const btn = $(btnId);
      if (!btn) return;
      btn.onclick = async () => {
        const text = $(preId) ? $(preId).textContent : "";
        if (!text) return;
        const orig = btn.dataset.origLabel || btn.textContent;
        btn.dataset.origLabel = orig;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = tr("✓ 已复制", "✓ Copied");
          notify(tr("已复制接入配置到剪贴板。", "Snippet copied."));
          setTimeout(() => { btn.textContent = orig; }, 2000);
        } catch {
          notify(tr("复制失败，请手动选中复制。", "Copy failed."), true);
        }
      };
    }
    bindSnippetCopy("copyShareSnippetBtn", "snippetShare");
    bindSnippetCopy("copyOpenaiSnippetBtn", "snippetOpenai");
    bindSnippetCopy("copyClaudeSnippetBtn", "snippetClaude");

    // ==================== REQUEST LOGS & CHAT-BLOCK INSPECTOR ====================
    function execModeLabel(mode) {
      if (mode === "incognito") return tr("无痕隐私", "Incognito");
      if (mode === "cloud") return tr("云端留存", "Cloud Saved");
      if (mode === "parked_tool_resume") return tr("增量续跑", "Incremental");
      if (mode === "warm_incremental") return tr("增量复用", "Incremental");
      if (mode === "fresh") return tr("标准会话", "Standard");
      return "—";
    }

    function renderLogsTable() {
      const accFilter = $("logAccountFilter").value;
      const typeFilter = $("logFilterSelect").value;
      const kw = $("logSearchInput").value.trim().toLowerCase();

      const filtered = logsCache.filter((r) => {
        if (accFilter !== "all" && r.slotId !== accFilter) return false;
        if (typeFilter === "running" && r.status !== "running") return false;
        if (typeFilter === "tools" && !(r.emittedToolCallsCount > 0 || r.execMode === "parked_tool_resume")) return false;
        if (typeFilter === "thinking" && !r.hasThinking) return false;
        if (typeFilter === "error" && r.status !== "error") return false;
        if (kw) {
          const hay = (r.requestedModel + " " + (r.accountLabel || "") + " " + (r.maskedKey || "") + " " + (r.client || "") + " " + (r.userAgent || "")).toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      });
      $("navLogCount").textContent = logsCache.length;

      $("logsTableBody").innerHTML = filtered.length ? filtered.map((r) => {
        const stHtml = r.status === "running"
          ? '<span class="status-line" style="color:var(--warn);"><span class="dot dot-pulse"></span>' + esc(tr("生成中", "Running")) + '</span>'
          : r.status === "error"
            ? '<span class="status-line" style="color:var(--err);"><span class="dot dot-err"></span>' + r.httpStatus + '</span>'
            : '<span class="status-line"><span class="dot dot-ok"></span>200</span>';

        const modeBadge = r.execMode === "warm_incremental"
          ? '<span class="tag tag-info" style="font-size:10.5px;">' + esc(tr("增量复用", "Incremental")) + '</span>'
          : r.execMode === "incognito"
            ? '<span class="tag tag-ok" style="font-size:10.5px;">' + esc(tr("无痕隐私", "Incognito")) + '</span>'
            : r.execMode === "cloud"
              ? '<span class="tag" style="font-size:10.5px;color:var(--warn);">' + esc(tr("云端留存", "Cloud Saved")) + '</span>'
              : (r.execMode ? '<span class="tag" style="font-size:10.5px;">' + esc(execModeLabel(r.execMode)) + '</span>' : '');

        const badges = [];
        if (r.usedProxy) badges.push('<span class="tag">' + esc(tr("代理", "Proxy")) + '</span>');
        if (r.hasThinking) badges.push('<span class="tag">' + esc(tr("思考", "Thinking")) + '</span>');
        if (r.emittedToolCallsCount > 0) badges.push('<span class="tag">' + esc(tr("调工具×", "Tools ×")) + r.emittedToolCallsCount + '</span>');
        if (r.toolCount > 0 && r.emittedToolCallsCount === 0) badges.push('<span class="tag" style="opacity:0.7;">' + esc(tr("挂", "")) + r.toolCount + esc(tr("工具", " tools")) + '</span>');

        const m = r.metrics || {};
        if (m.sessionDeleted) badges.push('<span class="tag">' + esc(tr('已删会话', 'Deleted')) + '</span>');
        const routedShort = m.resolvedModel ? String(m.resolvedModel).replace(/^us\.anthropic\./, "") : "";
        const routedCls = routedShort.toLowerCase().includes("opus")
          ? "routed-opus"
          : routedShort.toLowerCase().includes("sonnet")
            ? "routed-sonnet"
            : routedShort.toLowerCase().includes("haiku")
              ? "routed-haiku"
              : "routed-other";
        const routedPillHtml = routedShort ? '<span class="routed-pill ' + routedCls + '">→ ' + esc(routedShort) + '</span>' : '';
        const dur = r.durationMs != null ? (r.durationMs / 1000).toFixed(2) + "s" : "—";
        const ttft = r.ttftMs != null ? (r.ttftMs / 1000).toFixed(2) + "s" : "—";

        return '<tr class="clickable-row" data-click="openTrace" data-arg="' + esc(r.id) + '">' +
          '<td class="mono" style="white-space:nowrap;">' + new Date(r.startedAt).toLocaleTimeString() + '</td>' +
          '<td>' + stHtml + '</td>' +
          '<td><div class="mono" style="font-weight:500;">' + esc(r.requestedModel) + routedPillHtml + '</div>' +
            '<div style="font-size:11px;color:var(--fg-muted);">' + esc(r.protocol) + (r.stream ? ' · SSE' : ' · JSON') + (r.client ? (' · ' + esc(r.client)) : '') + (r.clientKeyName ? (' · ' + esc(r.clientKeyName)) : '') + (r.clientIp ? (' · IP ' + esc(r.clientIp)) : '') + '</div></td>' +
          '<td><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><span>' + esc(r.accountLabel || r.maskedKey || '—') + '</span>' + modeBadge + '</div></td>' +
          '<td style="max-width:340px;">' +
            (badges.length ? '<div style="display:flex;gap:4px;margin-bottom:3px;flex-wrap:wrap;">' + badges.join("") + '</div>' : '') +
            '<div style="color:var(--fg-muted);font-size:12px;">' + esc(tr("输出 ", "Out ")) + fmt(r.outputChars || 0) + esc(tr(" 字 · 上下文 ", " ch · Context ")) + fmt(r.transcriptTotalChars || 0) + esc(tr(" 字", " ch")) + '</div>' +
          '</td>' +
          '<td class="mono" style="white-space:nowrap;">' + ttft + ' / ' + dur + '</td>' +
          '<td class="mono" style="white-space:nowrap;">' + fmtTok(m.inputTokens) + ' / <span style="color:var(--ok);">' + fmtTok(m.cacheReadTokens) + '</span> / ' + fmtTok(m.outputTokens) + '</td>' +
        '</tr>';
      }).join("") : '<tr><td colspan="7" style="text-align:center;color:var(--fg-muted);padding:32px;">' + esc(logsCache.length === 0 ? tr('当前暂无内存实时日志（服务重启会清空内存日志；历史累计与最近 10 条请求见「总览监控」）', 'No in-memory logs yet (restarts clear memory logs; historical stats & latest 10 requests remain in Overview)') : tr('当前筛选条件下无匹配日志', 'No matching request logs')) + '</td></tr>';
    }

    async function fetchLogs() {
      try {
        const data = await api("/v1/admin/logs");
        logsCache = data.logs || [];
        renderLogsTable();
        if (openTraceId) {
          const detail = await api("/v1/admin/logs/" + openTraceId).catch(() => null);
          if (detail) {
            openTraceDetail = detail;
            renderDrawerContent();
          }
        }
      } catch {}
    }

    window.openTrace = async (id) => {
      openTraceId = id;
      $("traceDrawer").classList.add("open");
      $("drTitle").textContent = tr("加载中 ", "Loading ") + id + "...";
      $("drBody").innerHTML = '<div style="color:var(--fg-muted);">' + esc(tr("正在读取...", "Loading...")) + '</div>';
      try {
        openTraceDetail = await api("/v1/admin/logs/" + id);
        renderDrawerContent();
      } catch (e) {
        $("drBody").innerHTML = '<div style="color:var(--err);">' + esc(tr("读取失败: ", "Failed to load: ")) + esc(e.message) + '</div>';
      }
    };

    window.closeTraceDrawer = () => {
      openTraceId = null;
      openTraceDetail = null;
      $("traceDrawer").classList.remove("open");
    };

    $("drRefreshBtn").onclick = async () => {
      if (!openTraceId) return;
      await window.openTrace(openTraceId);
      notify(tr("已刷新请求详情。", "Request detail refreshed."));
    };

    function renderDrawerContent() {
      const d = openTraceDetail;
      if (!d) return;
      const m = d.metrics || {};
      const dur = d.durationMs != null ? (d.durationMs / 1000).toFixed(2) + "s" : tr("进行中", "Running");
      const ttft = d.ttftMs != null ? (d.ttftMs / 1000).toFixed(2) + "s" : "—";
      $("drTitle").textContent = d.requestedModel + " · " + (d.status === "running" ? tr("生成中...", "Running...") : ("HTTP " + d.httpStatus));
      $("drSubtitle").textContent = d.id + " · " + new Date(d.startedAt).toLocaleString() + " · " + (d.accountLabel || d.maskedKey || "—") + (d.clientIp ? " · IP " + d.clientIp : "");

      const sentChars = d.upstreamSentChars || 0;
      const totalChars = d.transcriptTotalChars || 0;
      const savedNote = (d.execMode === "parked_tool_resume" || d.execMode === "warm_incremental")
        ? (tr('仅发增量 ', 'Sent delta ') + fmt(sentChars) + tr(' 字 (客户端带全量 ', ' ch (skipped ') + fmt(totalChars) + tr(' 字未重传)', ' ch full context)'))
        : (tr('全量发送 ', 'Full send ') + fmt(sentChars) + tr(' 字', ' ch'));
      const fp = d.fingerprint || {};
      const row = (k, v) => '<div class="kv-item"><span>' + k + '</span><strong class="mono">' + v + '</strong></div>';
      const tools = d.toolNames || [];

      $("drBody").innerHTML =
        '<div class="kv-grid">' +
          '<div class="kv-item"><span>' + esc(tr('执行模式 & 网络实发', 'Execution Mode & Payload')) + '</span><strong>' + esc(execModeLabel(d.execMode)) + '</strong><span style="margin-top:2px;">' + esc(savedNote) + '</span></div>' +
          '<div class="kv-item"><span>' + esc(tr('首包 TTFT / 总耗时 & Tokens', 'TTFT / Total & Tokens')) + '</span><strong class="mono">' + ttft + ' / ' + dur + '</strong><span class="mono" style="margin-top:2px;">' + esc(tr('新发入 ', 'In ')) + fmtTok(m.inputTokens) + esc(tr(' · 缓存读 ', ' · Cache ')) + fmtTok(m.cacheReadTokens) + esc(tr(' · 输出 ', ' · Out ')) + fmtTok(m.outputTokens) + '</span></div>' +
          row(esc(tr('消息数 / 附图', 'Messages / Images')), fmt(d.messageCount || 0) + ' / ' + fmt(d.imageCount || 0)) +
          row(esc(tr('输出字数 / 思考 / 工具调用', 'Output Chars / Thinking / Tool Calls')), fmt(d.outputChars || 0) + ' / ' + (d.hasThinking ? tr('有', 'Yes') : tr('无', 'No')) + ' / ' + (d.emittedToolCallsCount || 0)) +
          row(esc(tr('会话指纹', 'Conversation Hash')), esc(fp.conversation || '—')) +
          row(esc(tr('前缀指纹 (上轮 → 本轮)', 'Prefix Hash (Prev → Cur)')), esc(fp.priorPrefix || '—') + ' → ' + esc(fp.currentPrefix || '—')) +
          row(esc(tr('挂载工具', 'Attached Tools')), tools.length ? esc(tools.join(', ')) : tr('无', 'None')) +
          row(esc(tr('客户端', 'Client')), esc(d.client || '—')) +
          row('User-Agent', esc(d.userAgent || '—')) +
          row(esc(tr('结束原因', 'Stop Reason')), esc(d.stopReason || '—')) +
        '</div>' +
        (d.errorMessage ? '<div><span class="field-lbl" style="color:var(--err);">' + esc(tr('错误信息', 'Error Message')) + '</span><pre class="code-block mono" style="border-color:var(--err);color:var(--err);">' + esc(d.errorMessage) + '</pre></div>' : '') +
        '<div style="font-size:12px;color:var(--fg-muted);">' + esc(tr('指纹是单向短哈希，仅用于判断两次请求是否属于同一对话前缀，无法还原内容。', 'Hashes are one-way 8-char fingerprints used only to match conversation prefixes; content cannot be reconstructed.')) + '</div>';
    }

    $("logAccountFilter").onchange = renderLogsTable;
    $("logFilterSelect").onchange = renderLogsTable;
    $("logSearchInput").oninput = renderLogsTable;
    $("manualRefreshLogsBtn").onclick = async () => {
      await fetchLogs();
      notify(tr("已刷新实时请求日志。", "Request logs refreshed."));
    };
    $("clearLogsBtn").onclick = async () => {
      const ok = await uiConfirm({
        title: tr("清空请求日志", "Clear Request Logs"),
        desc: tr("确定清空内存中的请求日志吗？（仅含元数据，不影响历史总览统计）", "Clear in-memory request logs? (Metadata only)"),
        okText: tr("确认清空", "Clear"),
        danger: true
      });
      if (!ok) return;
      await api("/v1/admin/logs/clear", { method: "POST", body: "{}" });
      notify(tr("已清空实时请求日志。", "Request logs cleared."));
      await fetchLogs();
    };
    $("livePollLogsBtn").onclick = () => {
      liveLogsPoll = !liveLogsPoll;
      $("livePollLogsBtn").textContent = tr("实时刷新(3s): ", "Live Poll (3s): ") + (liveLogsPoll ? tr("开", "ON") : tr("关", "OFF"));
      notify(liveLogsPoll ? tr("已开启日志实时轮询（每 3 秒）。", "Live log polling enabled (3s).") : tr("已暂停日志实时轮询。", "Live log polling paused."));
    };

    setInterval(() => {
      if (liveLogsPoll && $("appShell").style.display !== "none" && (activeTab === "logs" || openTraceId)) {
        fetchLogs();
      }
    }, 3000);

    // ==================== MODEL ACCESS CONTROL ====================
    function getFilteredModels() {
      const kw = ($("modelSearchInput") ? $("modelSearchInput").value : "").trim().toLowerCase();
      return modelsCatalogCache.filter((m) => {
        if (kw && !(m.id.toLowerCase().includes(kw) || (m.displayName || "").toLowerCase().includes(kw))) return false;
        return true;
      });
    }

    function modelRoleLabel(id) {
      if (id === "claude-haiku-5-5") return tr("轻量极速 · 日常问答", "Fast · Everyday tasks");
      if (id === "claude-sonnet-5-5") return tr("均衡主力 · 代码与通用", "Balanced · Coding & general");
      if (id === "claude-opus-5-5") return tr("旗舰推理 · 复杂任务", "Flagship · Complex reasoning");
      return "—";
    }

    function renderModelsTable() {
      const filtered = getFilteredModels();
      const enabledTotal = modelsCatalogCache.filter((m) => m.enabled).length;
      $("navModelCount").textContent = enabledTotal + "/" + modelsCatalogCache.length;
      $("modelSelSummary").textContent = tr("已勾选 ", "") + selectedModelIds.size + tr(" 项 (当前显示 ", " selected (showing ") + filtered.length + tr(" 项)", ")");

      $("modelSelectAllCb").checked = filtered.length > 0 && filtered.every((m) => selectedModelIds.has(m.id));

      $("modelsManageBody").innerHTML = filtered.length ? filtered.map((m) => {
        const checked = selectedModelIds.has(m.id) ? "checked" : "";
        const paramsStr = (m.parameters || []).length ? m.parameters.join(", ") : "—";
        return '<tr class="' + (!m.enabled ? 'row-disabled' : '') + '">' +
          '<td><input type="checkbox" ' + checked + ' data-change="toggleModelSelect" data-arg="' + esc(m.id) + '" /></td>' +
          '<td><label class="switch"><input type="checkbox" ' + (m.enabled ? 'checked' : '') + ' data-change="toggleSingleModel" data-arg="' + esc(m.id) + '" /><span class="slider"></span></label></td>' +
          '<td class="mono" style="font-weight:500;">' + esc(m.id) + '</td>' +
          '<td>' + esc(m.displayName) + '</td>' +
          '<td style="color:var(--fg-muted);font-size:12px;">' + esc(modelRoleLabel(m.id)) + '</td>' +
          '<td class="mono" style="color:var(--fg-muted);">' + esc(paramsStr) + '</td>' +
        '</tr>';
      }).join("") : '<tr><td colspan="6" style="text-align:center;color:var(--fg-muted);padding:24px;">' + esc(tr("无匹配模型", "No matching models")) + '</td></tr>';
    }

    async function loadModelsCatalog(showToast = false) {
      $("refreshModelsBtn").disabled = true;
      $("refreshModelsBtn").textContent = tr("加载中...", "Loading...");
      try {
        const res = await api("/v1/admin/models");
        modelsCatalogCache = res.models || [];
        renderModelsTable();
        if (showToast) {
          notify(tr("已刷新上游模型目录（共 " + modelsCatalogCache.length + " 个模型）。", "Refreshed model catalog (" + modelsCatalogCache.length + " models)."));
        }
      } catch (e) {
        notify(tr("加载模型目录失败: ", "Failed to load catalog: ") + e.message, true);
      } finally {
        $("refreshModelsBtn").disabled = false;
        $("refreshModelsBtn").textContent = tr("刷新上游模型目录", "Refresh Catalog");
      }
    }

    window.toggleModelSelect = (id, checked) => {
      if (checked) selectedModelIds.add(id);
      else selectedModelIds.delete(id);
      renderModelsTable();
    };

    $("modelSelectAllCb").onchange = (ev) => {
      const checked = ev.target.checked;
      getFilteredModels().forEach((m) => {
        if (checked) selectedModelIds.add(m.id);
        else selectedModelIds.delete(m.id);
      });
      renderModelsTable();
    };

    $("modelSearchInput").oninput = renderModelsTable;
    $("refreshModelsBtn").onclick = () => void loadModelsCatalog(true);

    async function runModelBatch(action, modelsList, msg) {
      try {
        await api("/v1/admin/models/batch", {
          method: "POST",
          body: JSON.stringify({
            action,
            models: modelsList,
            allCatalogIds: modelsCatalogCache.map((m) => m.id)
          })
        });
        await loadModelsCatalog();
        if (msg) notify(msg);
      } catch (e) { notify(e.message, true); }
    }

    window.toggleSingleModel = (id, enabled) => {
      runModelBatch(enabled ? "enable" : "disable", [id], enabled ? tr("已启用模型: ", "Enabled model: ") + id : tr("已禁用模型: ", "Disabled model: ") + id);
    };

    $("batchEnableBtn").onclick = () => {
      if (!selectedModelIds.size) return notify(tr("请先勾选要操作的模型。", "Select at least one model first."), true);
      runModelBatch("enable", [...selectedModelIds], tr("已批量启用 ", "Enabled ") + selectedModelIds.size + tr(" 个模型。", " models."));
    };
    $("batchDisableBtn").onclick = () => {
      if (!selectedModelIds.size) return notify(tr("请先勾选要操作的模型。", "Select at least one model first."), true);
      runModelBatch("disable", [...selectedModelIds], tr("已批量禁用 ", "Disabled ") + selectedModelIds.size + tr(" 个模型。", " models."));
    };
    $("batchWhitelistBtn").onclick = async () => {
      if (!selectedModelIds.size) return notify(tr("请先勾选要保留启用的白名单模型。", "Select models for the whitelist first."), true);
      const ok = await uiConfirm({
        title: tr("应用模型白名单", "Apply Model Whitelist"),
        desc: tr("确定仅保留已勾选的 " + selectedModelIds.size + " 个模型对外开放，并禁用其余所有模型吗？", "Keep only the " + selectedModelIds.size + " selected models enabled and disable all others?"),
        okText: tr("确认应用", "Apply")
      });
      if (!ok) return;
      runModelBatch("set_only_enabled", [...selectedModelIds], tr("已应用白名单模式，仅开放勾选的 ", "Whitelist applied: ") + selectedModelIds.size + tr(" 个模型。", " models enabled."));
    };
    if ($("batchDisableApiPoolBtn")) {
      $("batchDisableApiPoolBtn").onclick = () => {};
    }
    $("batchEnableAllBtn").onclick = () => {
      runModelBatch("enable_all", [], tr("已恢复启用全部模型。", "All models enabled."));
    };

    // ==================== CLIENT GATEWAY SUB-KEYS MANAGEMENT ====================
    let selectedCkConnectId = "";
    let activeCkConnectTab = "share";
    const ckRevealedCache = {};

    window.setCkConnectTab = (tab) => {
      activeCkConnectTab = tab || "share";
      document.querySelectorAll("#ckConnectSeg button").forEach((b) => b.classList.toggle("active", b.dataset.arg === activeCkConnectTab));
      if ($("ckPaneShare")) $("ckPaneShare").style.display = activeCkConnectTab === "share" ? "flex" : "none";
      if ($("ckPaneOpenai")) $("ckPaneOpenai").style.display = activeCkConnectTab === "openai" ? "flex" : "none";
      if ($("ckPaneAnthropic")) $("ckPaneAnthropic").style.display = activeCkConnectTab === "anthropic" ? "flex" : "none";
      if ($("ckPaneTest")) $("ckPaneTest").style.display = activeCkConnectTab === "test" ? "flex" : "none";
    };

    function renderCkConnectSnippets(ck, rawToken) {
      const originBase = location.origin + basePath;
      const keyStr = rawToken || tr("<请先创建或选择一把子密钥>", "<SELECT_OR_CREATE_SUB_KEY>");
      const allowedList = ck && !ck.allowAllModels && (ck.allowedModels || []).length
        ? ck.allowedModels
        : ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
      const sampleModel = allowedList[0] || "claude-sonnet-5-5";
      if ($("ckConnectTitle")) {
        $("ckConnectTitle").textContent = ck
          ? tr("快捷接入与在线测试 · 当前密钥：", "Quick Connect & Test · ") + ck.name
          : tr("快捷接入、分享与在线测试", "Quick Connect, Share & Test");
      }
      if ($("snippetShare")) {
        $("snippetShare").textContent =
          tr("接口地址 (Base URL): ", "Base URL: ") + originBase + "/v1\\n" +
          "API Key: " + keyStr + "\\n" +
          tr("可用模型: ", "Models: ") + allowedList.join(" | ");
      }
      if ($("snippetOpenai")) {
        $("snippetOpenai").textContent =
          "Base URL: " + originBase + "/v1\\n" +
          "API Key : " + keyStr + "\\n\\n" +
          "curl " + originBase + "/v1/chat/completions \\\\\\n" +
          "  -H \\\"Authorization: Bearer " + keyStr + "\\\" \\\\\\n" +
          "  -H \\\"Content-Type: application/json\\\" \\\\\\n" +
          "  -d '{\\\"model\\\":\\\"" + sampleModel + "\\\",\\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"Hello\\\"}]}'";
      }
      if ($("snippetClaude")) {
        $("snippetClaude").textContent =
          "export ANTHROPIC_BASE_URL=\\\"" + originBase + "\\\"\\n" +
          "export ANTHROPIC_AUTH_TOKEN=\\\"" + keyStr + "\\\"\\n" +
          "export ANTHROPIC_API_KEY=\\\"" + keyStr + "\\\"\\n\\n" +
          "curl " + originBase + "/v1/messages \\\\\\n" +
          "  -H \\\"x-api-key: " + keyStr + "\\\" \\\\\\n" +
          "  -H \\\"anthropic-version: 2023-06-01\\\" \\\\\\n" +
          "  -H \\\"content-type: application/json\\\" \\\\\\n" +
          "  -d '{\\\"model\\\":\\\"" + sampleModel + "\\\",\\\"max_tokens\\\":512,\\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"Hello\\\"}]}'";
      }
    }

    window.selectCkForConnect = async (id, showToast = true) => {
      const found = clientKeysCache.find((k) => k.id === id);
      if (!found) {
        renderCkConnectSnippets(null, "");
        return;
      }
      selectedCkConnectId = id;
      renderClientKeysTable();
      try {
        if (!ckRevealedCache[id]) {
          const res = await api("/v1/admin/client-keys/" + id + "/reveal");
          ckRevealedCache[id] = res.token;
        }
        renderCkConnectSnippets(found, ckRevealedCache[id]);
        if (showToast) {
          notify(tr("已将密钥 「" + found.name + "」 的真实地址与 Key 填入下方接入示例。", "Loaded real URL & key for '" + found.name + "' into connect snippets."));
          if ($("ckConnectPanel")) $("ckConnectPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      } catch (e) {
        if (showToast) notify(e.message, true);
      }
    };

    async function loadClientKeys() {
      try {
        const res = await api("/v1/admin/client-keys");
        clientKeysCache = res.clientKeys || [];
        $("navClientKeyCount").textContent = clientKeysCache.length;
        renderClientKeysTable();
        const curExists = clientKeysCache.some((k) => k.id === selectedCkConnectId);
        if (!curExists && clientKeysCache.length > 0) {
          const preferred = clientKeysCache.find((k) => k.enabled) || clientKeysCache[0];
          void window.selectCkForConnect(preferred.id, false);
        } else if (curExists) {
          const found = clientKeysCache.find((k) => k.id === selectedCkConnectId);
          renderCkConnectSnippets(found, ckRevealedCache[selectedCkConnectId] || "");
        } else {
          renderCkConnectSnippets(null, "");
        }
      } catch (e) { notify(e.message, true); }
    }

    window.copyCkToken = async (id) => {
      try {
        const res = await api("/v1/admin/client-keys/" + id + "/reveal");
        const found = clientKeysCache.find((k) => k.id === id);
        try {
          await navigator.clipboard.writeText(res.token);
          notify(tr("已复制网关密钥 「", "Copied token for '") + (found ? found.name : id) + tr("」 的完整 Token！", "'!"));
        } catch {
          await uiPrompt({
            title: tr("复制完整网关密钥", "Copy Gateway Key"),
            desc: tr("浏览器剪贴板受限，请直接复制下方完整密钥：", "Clipboard restricted. Copy the full token below:"),
            value: res.token,
            okText: tr("关闭", "Close")
          });
        }
      } catch (e) { notify(e.message, true); }
    };

    window.resetCkUsedCount = async (id) => {
      const ok = await uiConfirm({
        title: tr("重置子密钥计数", "Reset Request Counter"),
        desc: tr("确定将该子密钥的已用请求次数归零重置吗？", "Reset used request count to 0 for this sub-key?"),
        okText: tr("确认重置", "Reset")
      });
      if (!ok) return;
      try {
        await api("/v1/admin/client-keys/" + id, {
          method: "PATCH",
          body: JSON.stringify({ resetRequests: true })
        });
        notify(tr("已重置该子密钥的调用次数计数。", "Request counter reset."));
        await loadClientKeys();
      } catch (e) { notify(e.message, true); }
    };

    function toLocalDatetimeInputVal(isoStr) {
      if (!isoStr) return "";
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return "";
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    window.setCkMaxConc = (v) => { $("ckMaxConcInput").value = v === "" ? "" : String(v); };
    window.setCkMaxReq = (v) => { $("ckMaxReqInput").value = v === "" ? "" : String(v); };
    window.setCkExpDays = (days) => {
      days = Number(days);
      if (!days) { $("ckExpiresInput").value = ""; return; }
      const target = new Date(Date.now() + days * 86400 * 1000);
      $("ckExpiresInput").value = toLocalDatetimeInputVal(target.toISOString());
    };

    function renderClientKeysTable() {
      $("clientKeysBody").innerHTML = clientKeysCache.length ? clientKeysCache.map((k) => {
        const scopeHtml = k.allowAllModels
          ? '<span class="tag tag-ok">' + esc(tr("跟随全局已启用模型 (不限)", "All enabled models")) + '</span>'
          : ('<div><span class="tag tag-warn">' + esc(tr("仅限指定 " + k.allowedModels.length + " 个模型", k.allowedModels.length + " models allowed")) + '</span>' +
             '<div class="mono" style="font-size:11px;color:var(--fg-muted);margin-top:3px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(k.allowedModels.join(", ")) + '">' +
               esc(k.allowedModels.join(", ")) +
             '</div></div>');

        const st = k.stats || {};
        const reqLimitStr = k.maxRequests != null
          ? (tr('已用 ', 'Used ') + fmt(st.requests) + ' / ' + fmt(k.maxRequests) + tr(' 次', ' reqs'))
          : (tr('已用 ', 'Used ') + fmt(st.requests) + tr(' 次 (无上限)', ' reqs (unlimited)'));
        const expStr = k.expiresAt
          ? (k.isExpired ? (tr('已于 ', 'Expired ') + new Date(k.expiresAt).toLocaleString() + tr(' 过期', '')) : (tr('至 ', 'Until ') + new Date(k.expiresAt).toLocaleString()))
          : tr('永不过期', 'Never expires');

        const limitColor = (k.isExpired || k.isQuotaExhausted) ? 'var(--err)' : 'var(--fg)';
        const limitHtml = '<div style="color:' + limitColor + ';font-size:12px;">' +
          '<div style="font-size:11px;color:var(--fg-muted);">' + esc(tr('并发 ', 'Concurrency ')) + (k.maxConcurrent != null ? esc(k.maxConcurrent) : esc(tr('不限', 'Unlimited'))) + '</div>' +
          '<div class="mono">' + esc(reqLimitStr) + (k.isQuotaExhausted ? ' <span class="tag" style="color:var(--err);border-color:var(--err);">' + esc(tr('次数耗尽', 'Exhausted')) + '</span>' : '') + '</div>' +
          '<div style="font-size:11px;color:' + (k.isExpired ? 'var(--err)' : 'var(--fg-muted)') + ';">' + esc(expStr) + '</div>' +
        '</div>';

        const lastTime = st.lastUsedAt ? new Date(st.lastUsedAt).toLocaleString() : tr("尚未使用", "Never used");
        const isPicked = k.id === selectedCkConnectId;
        const rowCls = [(!k.enabled || k.isExpired || k.isQuotaExhausted) ? 'row-disabled' : '', isPicked ? 'row-picked' : ''].filter(Boolean).join(' ');
        return '<tr class="' + rowCls + '">' +
          '<td><label class="switch"><input type="checkbox" ' + (k.enabled ? 'checked' : '') + ' data-change="toggleCkEnabled" data-arg="' + esc(k.id) + '" /><span class="slider"></span></label></td>' +
          '<td style="font-weight:500;">' + esc(k.name) + (k.source === 'env' ? ' <span class="tag" style="margin-left:4px;font-size:10px;" title="' + esc(tr('来自 .env 的 GATEWAY_TOKEN；在这里删除即永久撤销，重启不会再生成', 'From GATEWAY_TOKEN in .env; deleting it here revokes it permanently and it will not be re-created on restart')) + '">.env</span>' : '') + (isPicked ? ' <span class="tag tag-ok" style="margin-left:4px;font-size:10px;">' + esc(tr('当前接入', 'Active')) + '</span>' : '') + '</td>' +
          '<td><span class="mono" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;" title="' + esc(tr('点击在下方回显真实接入示例', 'Click to load real connect snippets below')) + '" data-click="selectCkForConnect" data-arg="' + esc(k.id) + '">' + esc(k.maskedToken) + '</span> <button class="btn-xs" style="margin-left:6px;" data-click="copyCkToken" data-arg="' + esc(k.id) + '">' + esc(tr('复制', 'Copy')) + '</button></td>' +
          '<td>' + scopeHtml + '</td>' +
          '<td>' + limitHtml + '</td>' +
          '<td class="mono" style="font-size:11.5px;"><div>' + esc(tr('入 ', 'In ')) + fmtTok(st.inputTokens) + esc(tr(' / 出 ', ' / Out ')) + fmtTok(st.outputTokens) + '</div><div style="color:var(--fg-muted);">' + esc(lastTime) + '</div></td>' +
          '<td class="ops-cell"><div class="ops-stack">' +
            '<button class="btn-xs" data-click="selectCkForConnect" data-arg="' + esc(k.id) + '">' + esc(tr('接入', 'Connect')) + '</button>' +
            '<button class="btn-xs" data-click="openEditCkModal" data-arg="' + esc(k.id) + '">' + esc(tr('编辑配置', 'Edit')) + '</button>' +
            (k.maxRequests != null && st.requests > 0 ? '<button class="btn-xs" data-click="resetCkUsedCount" data-arg="' + esc(k.id) + '">' + esc(tr('重置次数', 'Reset')) + '</button>' : '') +
            '<button class="btn-xs btn-danger" data-click="deleteCk" data-arg="' + esc(k.id) + '">' + esc(tr('删除', 'Delete')) + '</button>' +
          '</div></td>' +
        '</tr>';
      }).join("") : '<tr><td colspan="7" style="text-align:center;color:var(--fg-muted);padding:24px;">' + esc(tr("暂无网关密钥", "No sub-keys")) + '</td></tr>';
    }

    function renderCkChecklist() {
      const kw = $("ckModelSearch").value.trim().toLowerCase();
      const list = modelsCatalogCache.filter((m) =>
        !kw || m.id.toLowerCase().includes(kw) || (m.displayName || "").toLowerCase().includes(kw)
      );
      $("ckPickedCountLabel").textContent = tr("已选 ", "Picked ") + ckPickedModels.size + " / " + modelsCatalogCache.length;

      $("ckModelsChecklist").innerHTML = list.length ? list.map((m) => {
        const isChecked = ckPickedModels.has(m.id);
        const checkedAttr = isChecked ? "checked" : "";
        return '<label class="ck-card ' + (isChecked ? 'picked' : '') + '">' +
          '<input type="checkbox" style="flex-shrink:0;" ' + checkedAttr + ' data-change="onCkModelTick" data-arg="' + esc(m.id) + '" />' +
          '<div class="ck-card-info">' +
            '<div class="ck-card-id mono" title="' + esc(m.id) + '">' + esc(m.id) + '</div>' +
            '<div class="ck-card-name" title="' + esc(m.displayName) + '">' + esc(m.displayName) + '</div>' +
          '</div>' +
        '</label>';
      }).join("") : '<div style="grid-column:1/-1;color:var(--fg-muted);padding:16px;text-align:center;font-size:12px;">' + esc(tr("无匹配模型", "No matching models")) + '</div>';
    }

    window.onCkModelTick = (id, checked) => {
      if (checked) ckPickedModels.add(id);
      else ckPickedModels.delete(id);
      renderCkChecklist();
    };

    $("ckScopeSelect").onchange = () => {
      $("ckModelsPickerWrap").style.display = $("ckScopeSelect").value === "custom" ? "block" : "none";
      if ($("ckScopeSelect").value === "custom") renderCkChecklist();
    };
    $("ckModelSearch").oninput = renderCkChecklist;
    $("ckPickAllBtn").onclick = () => {
      modelsCatalogCache.forEach((m) => ckPickedModels.add(m.id));
      renderCkChecklist();
    };
    $("ckPickNoneBtn").onclick = () => {
      ckPickedModels.clear();
      renderCkChecklist();
    };

    $("openCreateCkModalBtn").onclick = async () => {
      if (modelsCatalogCache.length === 0) await loadModelsCatalog();
      editingCkId = null;
      $("ckModalTitle").textContent = tr("创建网关子密钥", "Create Client Sub-Key");
      $("ckNameInput").value = "";
      $("ckTokenInput").value = "";
      $("ckMaxReqInput").value = "";
      $("ckMaxConcInput").value = "";
      $("ckExpiresInput").value = "";
      $("ckTokenFieldWrap").style.display = "block";
      $("ckScopeSelect").value = "all";
      syncSelectUi($("ckScopeSelect"));
      ckPickedModels.clear();
      modelsCatalogCache.filter((m) => m.enabled).forEach((m) => ckPickedModels.add(m.id));
      $("ckModelsPickerWrap").style.display = "none";
      renderCkChecklist();
      $("clientKeyModal").classList.add("open");
    };

    window.openEditCkModal = async (id) => {
      if (modelsCatalogCache.length === 0) await loadModelsCatalog();
      const found = clientKeysCache.find((k) => k.id === id);
      if (!found) return;
      editingCkId = id;
      $("ckModalTitle").textContent = tr("编辑子密钥权限与配额 · ", "Edit Sub-Key · ") + found.name;
      $("ckNameInput").value = found.name;
      $("ckMaxReqInput").value = found.maxRequests != null ? String(found.maxRequests) : "";
      $("ckMaxConcInput").value = found.maxConcurrent != null ? String(found.maxConcurrent) : "";
      $("ckExpiresInput").value = toLocalDatetimeInputVal(found.expiresAt);
      $("ckTokenFieldWrap").style.display = "none";
      $("ckScopeSelect").value = found.allowAllModels ? "all" : "custom";
      syncSelectUi($("ckScopeSelect"));
      ckPickedModels.clear();
      (found.allowedModels || []).forEach((m) => ckPickedModels.add(m));
      $("ckModelsPickerWrap").style.display = found.allowAllModels ? "none" : "block";
      renderCkChecklist();
      $("clientKeyModal").classList.add("open");
    };

    window.closeCkModal = () => { $("clientKeyModal").classList.remove("open"); };

    $("saveCkModalBtn").onclick = async () => {
      const name = $("ckNameInput").value.trim() || tr("网关子密钥", "Sub-Key");
      const allowAllModels = $("ckScopeSelect").value === "all";
      const allowedModels = [...ckPickedModels];
      const maxReqRaw = $("ckMaxReqInput").value.trim();
      const maxRequests = maxReqRaw ? Number(maxReqRaw) : null;
      const maxConcRaw = $("ckMaxConcInput").value.trim();
      const maxConcurrent = maxConcRaw ? Number(maxConcRaw) : null;
      const expRaw = $("ckExpiresInput").value.trim();
      const expiresAt = expRaw ? new Date(expRaw).toISOString() : null;

      if (!allowAllModels && allowedModels.length === 0) {
        return notify(tr("自定义模型白名单模式下，请至少勾选 1 个模型。", "Select at least one model under custom allowlist mode."), true);
      }
      $("saveCkModalBtn").disabled = true;
      try {
        if (editingCkId) {
          await api("/v1/admin/client-keys/" + editingCkId, {
            method: "PATCH",
            body: JSON.stringify({ name, allowAllModels, allowedModels, maxRequests, maxConcurrent, expiresAt })
          });
          notify(tr("已保存密钥 「" + name + "」 的权限与有效期配置。", "Saved sub-key '" + name + "'."));
        } else {
          const customToken = $("ckTokenInput").value.trim();
          const created = await api("/v1/admin/client-keys", {
            method: "POST",
            body: JSON.stringify({
              name,
              customToken: customToken || undefined,
              allowAllModels,
              allowedModels,
              maxRequests,
              maxConcurrent,
              expiresAt
            })
          });
          notify(tr("已创建子密钥 「" + name + "」: ", "Created sub-key '" + name + "': ") + created.rawToken);
        }
        closeCkModal();
        await loadClientKeys();
      } catch (e) { notify(e.message, true); }
      finally { $("saveCkModalBtn").disabled = false; }
    };

    window.toggleCkEnabled = async (id, enabled) => {
      try {
        await api("/v1/admin/client-keys/" + id, { method: "PATCH", body: JSON.stringify({ enabled }) });
        notify(enabled ? tr("已启用该网关子密钥。", "Gateway sub-key enabled.") : tr("已停用该网关子密钥。", "Gateway sub-key disabled."));
        await loadClientKeys();
      } catch (e) { notify(e.message, true); await loadClientKeys(); }
    };

    window.deleteCk = async (id) => {
      const target = clientKeysCache.find((k) => k.id === id);
      const fromEnv = !!target && target.source === 'env';
      const ok = await uiConfirm({
        title: tr("删除网关子密钥", "Delete Gateway Sub-Key"),
        desc: fromEnv
          ? tr("该密钥来自 .env 的 GATEWAY_TOKEN。删除后立即失效，且重启不会再自动生成；如需彻底清理，也请从 .env 中移除该令牌。", "This key comes from GATEWAY_TOKEN in .env. Deleting it revokes it immediately and it will NOT be re-created on restart; also remove the token from .env to clean up.")
          : tr("确定删除这把网关子密钥吗？使用该密钥的外部客户端将立即无法访问。", "Delete this sub-key? Clients using it will lose access immediately."),
        okText: tr("确认删除", "Delete"),
        danger: true
      });
      if (!ok) return;
      try {
        await api("/v1/admin/client-keys/" + id, { method: "DELETE" });
        notify(tr("已删除该网关子密钥。", "Gateway sub-key deleted."));
        await loadClientKeys();
      } catch (e) { notify(e.message, true); }
    };

    // ==================== CORE CONSOLE DATA & AUTH ====================
    async function loadConsoleData(querySuffix = "") {
      const syncBtns = Array.from(document.querySelectorAll("[data-sync-quota]"));
      syncBtns.forEach((b) => {
        b.disabled = true;
        b.textContent = querySuffix ? tr("同步中...", "Syncing...") : tr("加载中...", "Loading...");
      });
      try {
        const data = await api(querySuffix ? ("/v1/quota" + querySuffix) : "/v1/usage");
        renderAll(data);
        await Promise.all([fetchLogs(), loadClientKeys(), loadOverview()]);
        if (modelsCatalogCache.length === 0) void loadModelsCatalog();
        return data;
      } catch (e) {
        if ($("appShell").style.display !== "none") notify(e.message, true);
        return null;
      } finally {
        syncBtns.forEach((b) => {
          b.disabled = false;
          if (b.id === "credSyncQuotaBtn" && selectedCredIds.size > 0) {
            b.textContent = tr("同步所选 (" + selectedCredIds.size + ")", "Sync Selected (" + selectedCredIds.size + ")");
          } else {
            b.textContent = tr("同步最新额度", "Sync Quotas");
          }
        });
      }
    }

    $("loginForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const pwd = $("loginPwdInput").value.trim();
      if (!pwd) return;
      if (isInitialSetupMode) {
        if (pwd.length < 8) {
          $("loginErrText").textContent = tr("管理员密码长度至少为 8 位。", "Admin password must be at least 8 characters.");
          return;
        }
        const pwd2 = ($("loginPwdConfirmInput") ? $("loginPwdConfirmInput").value.trim() : "");
        if (pwd !== pwd2) {
          $("loginErrText").textContent = tr("两次输入的密码不一致。", "Passwords do not match.");
          return;
        }
      }
      $("loginSubmitBtn").disabled = true;
      $("loginErrText").textContent = "";
      try {
        const endpoint = isInitialSetupMode ? "/v1/admin/setup" : "/v1/admin/login";
        const res = await fetch(basePath + endpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Console-CSRF": "1", "X-Console-Lang": currentLang },
          body: JSON.stringify({ password: pwd })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data.error && data.error.message) || tr("密码错误", "Invalid password"));
        if (data.token) {
          sessionBearer = data.token;
          sessionStorage.setItem("cgw_session_bearer", data.token);
        }
        $("loginPwdInput").value = "";
        if ($("loginPwdConfirmInput")) $("loginPwdConfirmInput").value = "";
        applyLoginGateMode(false);
        showConsole();
        await loadConsoleData("");
        void checkAppVersion(false);
      } catch (err) {
        $("loginErrText").textContent = err.message;
      } finally {
        $("loginSubmitBtn").disabled = false;
      }
    };

    $("changePwdBtn").onclick = async () => {
      const next = await uiPrompt({
        title: tr("修改管理员密码", "Change Admin Password"),
        desc: tr("请输入新的后台管理员密码（至少 8 位），保存后立即生效并持久化到服务器 .env。", "Enter a new admin password (min 8 characters)."),
        type: "password",
        placeholder: tr("输入新密码（至少 8 位）", "New password (min 8 chars)"),
        okText: tr("保存新密码", "Update Password")
      });
      if (!next) return;
      if (next.trim().length < 8) {
        notify(tr("新管理密码长度至少为 8 位。", "New admin password must be at least 8 characters."), true);
        return;
      }
      try {
        const res = await api("/v1/admin/password", {
          method: "POST",
          body: JSON.stringify({ newPassword: next })
        });
        if (res.token) {
          sessionBearer = res.token;
          sessionStorage.setItem("cgw_session_bearer", res.token);
        }
        notify(tr("后台管理员密码已修改并持久化保存。", "Admin password updated and saved."));
      } catch (e) { notify(e.message, true); }
    };

    $("logoutBtn").onclick = async () => {
      await fetch(basePath + "/v1/admin/logout", { method: "POST", credentials: "same-origin", headers: { "X-Console-CSRF": "1" } }).catch(() => {});
      sessionBearer = "";
      sessionStorage.removeItem("cgw_session_bearer");
      showLoginGate();
    };

    document.querySelectorAll("[data-sync-quota]").forEach((b) => {
      b.onclick = async () => {
        const isCredBtn = b.id === "credSyncQuotaBtn";
        const selIds = isCredBtn ? [...selectedCredIds] : [];
        const targetIds = selIds.length > 0 ? selIds : poolSlotsCache.map((s) => s.slotId);
        targetIds.forEach((id) => busySyncIds.add(id));
        setCredPanelLoading();
        renderCredTable();
        const qs = selIds.length > 0
          ? ("?force=1&slotIds=" + encodeURIComponent(selIds.join(",")))
          : "?force=1";
        try {
          const data = await loadConsoleData(qs);
          if (!data) return;
          const accounts = Array.isArray(data.accounts) ? data.accounts : [];
          const okCount = accounts.filter((a) => a.status === "ok").length;
          const failed = accounts.filter((a) => a.status !== "ok");
          if (failed.length === 0) {
            notify(tr("同步成功：共 " + okCount + " 个账号已更新最新额度与云端会话。", "Synced " + okCount + " account(s) successfully."));
          } else {
            const firstErr = String(failed[0].error || tr("未知错误", "Unknown error")).slice(0, 120);
            notify(
              tr(
                "同步完成：成功 " + okCount + " 个，失败 " + failed.length + " 个（" + firstErr + "）",
                "Sync finished: " + okCount + " ok, " + failed.length + " failed (" + firstErr + ")"
              ),
              true
            );
          }
        } finally {
          targetIds.forEach((id) => busySyncIds.delete(id));
          setCredPanelLoading();
          renderCredTable();
        }
      };
    });

    window.toggleKey = async (slotId, enabled) => {
      try {
        await api("/v1/admin/keys/" + slotId, { method: "PATCH", body: JSON.stringify({ enabled }) });
        notify(enabled ? tr("已启用该凭证。", "Credential enabled.") : tr("已停用该凭证。", "Credential disabled."));
        await loadConsoleData(enabled ? "?force=1" : "");
      } catch (e) { notify(e.message, true); await loadConsoleData(""); }
    };

    window.editLabel = async (slotId, cur) => {
      const next = await uiPrompt({
        title: tr("修改凭证备注", "Edit Credential Label"),
        desc: tr("为该账号设置易于区分的备注名称（留空则清除自定义备注）。", "Set a custom label for this account (leave blank to clear)."),
        value: cur || "",
        placeholder: tr("例如：主力 Pro 1号", "e.g. Primary Pro #1"),
        okText: tr("保存备注", "Save")
      });
      if (next === null) return;
      try {
        await api("/v1/admin/keys/" + slotId, { method: "PATCH", body: JSON.stringify({ label: next }) });
        notify(tr("凭证备注已更新。", "Credential label updated."));
        await loadConsoleData("");
      } catch (e) { notify(e.message, true); }
    };

    window.recheckKey = async (slotId) => {
      try {
        const r = await api("/v1/admin/keys/" + slotId + "/recheck", { method: "POST", body: "{}" });
        notify(r.recovered ? tr("重新检测通过，已恢复调度。", "Recheck passed; scheduling resumed.") : (tr("重新检测后仍不可用：", "Still unavailable: ") + ((r.slot && r.slot.autoDisabledReason) || tr("请查看状态说明", "Check status"))), !r.recovered);
        await loadConsoleData("?force=1");
      } catch (e) { notify(e.message, true); }
    };

    // Per-credential quota sync: refreshes just this slot (no batch, no recovery sweep of other
    // accounts) and auto-re-enables it when the fresh telemetry shows quota is back.
    window.syncOneQuota = async (slotId) => {
      if (busySyncIds.has(slotId)) return;
      busySyncIds.add(slotId);
      renderCredTable();
      try {
        const data = await loadConsoleData("?force=1&slotIds=" + encodeURIComponent(slotId));
        const report = data && Array.isArray(data.accounts) ? data.accounts[0] : undefined;
        if (report && report.status === "ok") {
          const slot = (data.keyPool || []).find((s) => s.slotId === slotId);
          const q = slot && slot.quota ? slot.quota : null;
          const pct = q && q.premiumApiPool && q.premiumApiPool.usedPercent != null
            ? Number(q.premiumApiPool.usedPercent).toFixed(1) + "%"
            : tr("未提供", "n/a");
          notify(tr("已刷新该凭证额度：月度已用 ", "Quota refreshed: monthly usage ") + pct);
        } else {
          const reason = String((report && report.error) || tr("未知错误", "Unknown error")).slice(0, 120);
          notify(tr("刷新该凭证额度失败：", "Failed to refresh this credential: ") + reason, true);
          await loadConsoleData("");
        }
      } catch (e) {
        notify(e.message, true);
      } finally {
        busySyncIds.delete(slotId);
        renderCredTable();
      }
    };

    window.clearKeyCd = async (slotId) => {
      try {
        await api("/v1/admin/keys/" + slotId, { method: "PATCH", body: JSON.stringify({ clearCooldown: true }) });
        notify(tr("已解除该凭证的冷却限制。", "Credential cooldown cleared."));
        await loadConsoleData("");
      } catch (e) { notify(e.message, true); }
    };

    window.editProxy = async (slotId, curMasked) => {
      const val = await uiPrompt({
        title: tr("设置独立出口代理", "Configure Per-Credential Proxy"),
        desc: tr("仅对该凭证生效（支持 http://、https://、socks5:// 以及 ip:port / ip:port:user:pass / user:pass@ip:port 简写），留空确定则清除代理恢复直连。", "Applies only to this credential (supports http/https/socks5 and host:port:user:pass shorthand). Leave empty to clear."),
        value: curMasked && !curMasked.includes("***") ? curMasked : "",
        placeholder: "socks5://user:pass@1.2.3.4:1080 或 1.2.3.4:8080:user:pass",
        okText: tr("保存代理", "Save Proxy")
      });
      if (val === null) return;
      try {
        await api("/v1/admin/keys/" + slotId, { method: "PATCH", body: JSON.stringify({ proxyUrl: val.trim() }) });
        notify(val.trim() ? tr("已更新凭证专属代理。", "Credential proxy updated.") : tr("已清除凭证代理，恢复直连/全局代理。", "Credential proxy cleared."));
        await loadConsoleData("");
      } catch (e) { notify(e.message, true); }
    };

    window.editChatAgent = async (slotId, curAgentId) => {
      let activeBoundId = curAgentId || "";
      const overlay = document.createElement("div");
      overlay.className = "modal-mask open";
      const card = document.createElement("div");
      card.className = "modal-card";
      card.style.maxWidth = "520px";
      card.innerHTML =
        '<div class="panel-hdr">' +
          '<div>' +
            '<h2>' + esc(tr("自定义 Agent 管理", "Custom Agent Manager")) + '</h2>' +
            '<p>' + esc(tr("点击任意卡片即可立即切换并绑定该账号使用的 AWS Quick Agent。", "Click any agent card to switch immediately for this credential.")) + '</p>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<button type="button" class="btn-xs" id="agRefreshBtn">' + esc(tr("刷新", "Refresh")) + '</button>' +
            '<button type="button" class="btn-ghost" id="agCloseBtn" aria-label="Close" style="width:28px;height:28px;padding:0;">✕</button>' +
          '</div>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div id="agListBox" class="ag-list">' +
            '<div style="color:var(--fg-muted);padding:16px;text-align:center;">' + esc(tr("正在从 AWS Quick 拉取该账号的 Agent 列表…", "Loading agents from AWS Quick...")) + '</div>' +
          '</div>' +
          '<details class="ag-adv">' +
            '<summary>' + esc(tr("高级：手动输入或清空 Agent ID", "Advanced: Enter or clear Agent ID manually")) + '</summary>' +
            '<div style="display:flex;gap:8px;align-items:center;margin-top:10px;">' +
              '<input id="agManualInput" type="text" class="mono" style="flex:1;" placeholder="' + esc(tr("输入自定义 Agent ID，留空点保存即恢复默认", "Custom Agent ID (leave empty for default)")) + '" value="' + esc(activeBoundId) + '" />' +
              '<button type="button" id="agSaveBtn">' + esc(tr("保存", "Save")) + '</button>' +
            '</div>' +
          '</details>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button type="button" id="agCancelBtn">' + esc(tr("关闭", "Close")) + '</button>' +
          '<button type="button" class="btn-solid" id="agEnsureBtn">' + esc(tr("自动查找 / 创建编程 Agent", "Auto-Find / Create Coding Agent")) + '</button>' +
        '</div>';
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      const onKeyDown = (ev) => { if (ev.key === "Escape") close(); };
      const close = () => {
        document.removeEventListener("keydown", onKeyDown);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      };
      document.addEventListener("keydown", onKeyDown);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      card.querySelector("#agCloseBtn").addEventListener("click", close);
      card.querySelector("#agCancelBtn").addEventListener("click", close);

      const listBox = card.querySelector("#agListBox");
      const manualInput = card.querySelector("#agManualInput");
      const ensureBtn = card.querySelector("#agEnsureBtn");
      const refreshBtn = card.querySelector("#agRefreshBtn");
      const saveBtn = card.querySelector("#agSaveBtn");
      let busy = false;

      const bindId = async (agentId, displayName) => {
        if (busy) return;
        busy = true;
        try {
          await api("/v1/admin/keys/" + slotId, { method: "PATCH", body: JSON.stringify({ chatAgentId: agentId }) });
          activeBoundId = agentId;
          manualInput.value = agentId;
          notify(
            agentId
              ? tr("已切换为 ", "Switched to ") + (displayName || agentId)
              : tr("已恢复使用官方默认 Quick Agent。", "Restored official default Quick Agent.")
          );
          close();
          await loadConsoleData("");
        } catch (e) {
          notify(e.message, true);
        } finally {
          busy = false;
        }
      };

      const renderAgents = (agents, boundId) => {
        if (!Array.isArray(agents) || agents.length === 0) {
          listBox.innerHTML = '<div style="color:var(--fg-muted);padding:16px;text-align:center;">' + esc(tr("未查询到自定义 Agent，可点击右下角按钮一键自动创建。", "No agents found. Click Auto-Find / Create below.")) + '</div>';
          return;
        }
        listBox.innerHTML = "";
        agents.forEach((a) => {
          const isSystem = Boolean(a.isSystem);
          const isBound = isSystem
            ? !boundId
            : Boolean(boundId && (a.shortId === boundId || a.agentId === boundId));
          const btn = document.createElement("div");
          btn.setAttribute("role", "button");
          btn.tabIndex = isBound ? -1 : 0;
          btn.className = "ag-item" + (isBound ? " active" : "");
          const badgeHtml = isBound
            ? '<span class="ag-pill ok">● ' + esc(tr("当前使用", "Active")) + '</span>'
            : '<span class="ag-pill">' + esc(isSystem ? tr("切换默认", "Use Default") : tr("点击选用", "Select")) + '</span>';
          const tagHtml = isSystem
            ? '<span class="ag-pill">' + esc(tr("官方默认", "SYSTEM")) + '</span>'
            : '<span class="ag-pill">' + esc(tr("自定义", "Custom")) + '</span>';
          btn.innerHTML =
            '<div style="min-width:0;flex:1;">' +
              '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
                '<span style="font-weight:600;color:var(--fg);">' + esc(a.name || a.shortId) + '</span>' +
                tagHtml +
              '</div>' +
              '<div class="mono" style="font-size:11px;color:var(--fg-faint);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(a.shortId || a.agentId) + '</div>' +
              (a.description ? '<div style="font-size:12px;color:var(--fg-muted);margin-top:4px;line-height:1.45;">' + esc(a.description) + '</div>' : '') +
            '</div>' +
            '<div style="flex-shrink:0;display:flex;align-items:center;gap:6px;padding-top:2px;">' +
              (!isSystem ? '<button type="button" class="btn-xs ag-edit-prompt-btn">' + esc(tr("编辑提示词", "Edit Prompt")) + '</button>' : '') +
              badgeHtml +
            '</div>';
          if (!isSystem) {
            const editBtn = btn.querySelector(".ag-edit-prompt-btn");
            if (editBtn) {
              editBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                openPromptEditor(a);
              });
            }
          }
          if (!isBound) {
            const pick = () => bindId(isSystem ? "" : (a.shortId || a.agentId), a.name || a.shortId);
            btn.addEventListener("click", pick);
            btn.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
          }
          listBox.appendChild(btn);
        });
      };

      const openPromptEditor = (agent) => {
        const curPrompt = agent.systemPrompt || "";
        listBox.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:10px;";
        wrap.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
            '<div style="font-weight:600;font-size:13px;">' + esc(tr("编辑 Agent 提示词：", "Edit Agent Prompt: ") + (agent.name || agent.shortId)) + '</div>' +
            '<button type="button" class="btn-xs" id="agApplyTplBtn">' + esc(tr("套用全局模板", "Use Global Template")) + '</button>' +
          '</div>' +
          '<textarea id="agPromptTextarea" rows="5" style="width:100%;resize:vertical;line-height:1.5;">' + esc(curPrompt) + '</textarea>' +
          '<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;">' +
            '<button type="button" id="agPromptBackBtn">' + esc(tr("返回列表", "Back")) + '</button>' +
            '<button type="button" class="btn-solid" id="agPromptPublishBtn">' + esc(tr("保存并热发布到 AWS Quick", "Save & Publish")) + '</button>' +
          '</div>';
        listBox.appendChild(wrap);
        const ta = wrap.querySelector("#agPromptTextarea");
        wrap.querySelector("#agApplyTplBtn").addEventListener("click", () => {
          ta.value = window.__activeCustomAgentPrompt || window.__defaultCustomAgentPrompt || "";
        });
        wrap.querySelector("#agPromptBackBtn").addEventListener("click", () => fetchAgents());
        const pubBtn = wrap.querySelector("#agPromptPublishBtn");
        pubBtn.addEventListener("click", async () => {
          if (busy) return;
          busy = true;
          pubBtn.disabled = true;
          pubBtn.textContent = tr("发布中…", "Publishing...");
          try {
            const res = await api("/v1/admin/keys/" + slotId + "/agents/update", {
              method: "POST",
              body: JSON.stringify({ agentId: agent.shortId || agent.agentId, instructions: ta.value.trim() })
            });
            notify(tr("已热更新并发布该自定义 Agent 提示词。", "Custom agent prompt updated and published."));
            busy = false;
            renderAgents(res.agents || [], activeBoundId);
          } catch (e) {
            notify(e.message, true);
            pubBtn.disabled = false;
            pubBtn.textContent = tr("保存并热发布到 AWS Quick", "Save & Publish");
            busy = false;
          }
        });
      };

      const fetchAgents = async () => {
        refreshBtn.disabled = true;
        listBox.innerHTML = '<div style="color:var(--fg-muted);padding:16px;text-align:center;">' + esc(tr("正在拉取账号 Agent 列表…", "Loading agents...")) + '</div>';
        try {
          const data = await api("/v1/admin/keys/" + slotId + "/agents");
          activeBoundId = data.boundAgentId !== undefined ? data.boundAgentId : activeBoundId;
          manualInput.value = activeBoundId;
          renderAgents(data.agents || [], activeBoundId);
        } catch (e) {
          listBox.innerHTML = '<div style="color:var(--err);padding:14px;text-align:center;">' + esc(tr("拉取失败：", "Load failed: ") + (e.message || e)) + '</div>';
        } finally {
          refreshBtn.disabled = false;
        }
      };

      refreshBtn.addEventListener("click", fetchAgents);
      ensureBtn.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        ensureBtn.disabled = true;
        const origText = ensureBtn.textContent;
        ensureBtn.textContent = tr("处理中…", "Working...");
        try {
          const data = await api("/v1/admin/keys/" + slotId + "/agents/ensure", { method: "POST", body: JSON.stringify({}) });
          notify(tr("已自动绑定编程 Agent: ", "Auto-bound coding agent: ") + data.chatAgentId);
          close();
          await loadConsoleData("");
        } catch (e) {
          notify(e.message, true);
          ensureBtn.disabled = false;
          ensureBtn.textContent = origText;
          busy = false;
        }
      });
      saveBtn.addEventListener("click", () => bindId(manualInput.value.trim(), ""));
      manualInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") bindId(manualInput.value.trim(), ""); });
      await fetchAgents();
    };

    window.deleteKey = async (slotId) => {
      const ok = await uiConfirm({
        title: tr("移除 AWS Quick 凭证", "Remove Credential"),
        desc: tr("确认从网关移除该 AWS Quick 凭证吗？移除后可随时重新授权或导入。", "Remove this AWS Quick credential from the pool?"),
        okText: tr("确认移除", "Remove"),
        danger: true
      });
      if (!ok) return;
      try {
        await api("/v1/admin/keys/" + slotId, { method: "DELETE" });
        notify(tr("已移除该凭证。", "Credential removed."));
        await loadConsoleData("");
      } catch (e) { notify(e.message, true); }
    };

    let activeAddMode = "oauth";
    function switchAddMode(mode) {
      activeAddMode = mode === "curl" || mode === "batch" ? mode : "oauth";
      const isOAuth = activeAddMode === "oauth";
      const isCurl = activeAddMode === "curl";
      const isBatch = activeAddMode === "batch";
      if ($("addPaneOAuth")) $("addPaneOAuth").style.display = isOAuth ? "flex" : "none";
      if ($("addPaneCurl")) $("addPaneCurl").style.display = isCurl ? "flex" : "none";
      if ($("addPaneBatch")) $("addPaneBatch").style.display = isBatch ? "flex" : "none";
      if ($("addMoreOptionsWrap")) $("addMoreOptionsWrap").style.display = isBatch ? "none" : "flex";
      if ($("addMoreOptionsSummary")) {
        $("addMoreOptionsSummary").textContent = isOAuth
          ? tr("更多选项（独立代理 / 初始状态 / 企业工作区）", "More options (Proxy / Status / Enterprise)")
          : tr("更多选项（独立代理 / 初始状态）", "More options (Proxy / Status)");
      }
      if ($("oauthAccountTypeRow")) $("oauthAccountTypeRow").style.display = isOAuth ? "block" : "none";
      if ($("oauthEnterpriseFields")) {
        const isEnt = isOAuth && $("oauthAccountTypeSelect") && $("oauthAccountTypeSelect").value === "enterprise";
        $("oauthEnterpriseFields").style.display = isEnt ? "flex" : "none";
      }
      if ($("confirmAddKeyBtn")) {
        $("confirmAddKeyBtn").style.display = isOAuth ? "none" : "inline-flex";
        $("confirmAddKeyBtn").textContent = isBatch
          ? tr("确认批量导入并同步额度", "Batch Import & Sync")
          : tr("确认导入并同步额度", "Import & Sync");
      }
      if ($("addTabOAuth")) $("addTabOAuth").className = "seg-tab" + (isOAuth ? " active" : "");
      if ($("addTabCurl")) $("addTabCurl").className = "seg-tab" + (isCurl ? " active" : "");
      if ($("addTabBatch")) $("addTabBatch").className = "seg-tab" + (isBatch ? " active" : "");
    }
    if ($("oauthAccountTypeSelect")) {
      $("oauthAccountTypeSelect").onchange = () => {
        const isEnt = $("oauthAccountTypeSelect").value === "enterprise";
        if ($("oauthEnterpriseFields")) $("oauthEnterpriseFields").style.display = isEnt ? "flex" : "none";
      };
    }
    if ($("addTabOAuth")) $("addTabOAuth").onclick = () => switchAddMode("oauth");
    if ($("addTabCurl")) $("addTabCurl").onclick = () => { switchAddMode("curl"); if ($("modalKeysInput")) $("modalKeysInput").focus(); };
    if ($("addTabBatch")) $("addTabBatch").onclick = () => { switchAddMode("batch"); if ($("modalBatchJsonInput")) $("modalBatchJsonInput").focus(); };
    let currentDiscoveryUrl = "";
    let currentOAuthAuthUrl = "";
    function setOAuthWizardStep(step, summaryHint) {
      const isStep2 = step === 2;
      if ($("oauthStep1Card")) $("oauthStep1Card").style.display = isStep2 ? "none" : "flex";
      if ($("oauthStep2Wrap")) $("oauthStep2Wrap").style.display = isStep2 ? "flex" : "none";
      if ($("oauthStepPill1")) $("oauthStepPill1").className = "oauth-step-pill " + (isStep2 ? "done" : "active");
      if ($("oauthStepNum1")) $("oauthStepNum1").textContent = isStep2 ? "✓" : "1";
      if ($("oauthStepLine")) $("oauthStepLine").className = "oauth-step-line" + (isStep2 ? " done" : "");
      if ($("oauthStepPill2")) $("oauthStepPill2").className = "oauth-step-pill" + (isStep2 ? " active" : "");
      if (isStep2 && $("oauthStep1SummaryText")) {
        $("oauthStep1SummaryText").textContent = summaryHint
          ? tr("第 1 步已完成 · ", "Step 1 done · ") + summaryHint
          : tr("第 1 步已完成", "Step 1 done");
      }
    }
    function goBackToOAuthStep1() {
      stopOAuthPoll();
      activeOAuthFlowId = "";
      currentOAuthAuthUrl = "";
      if ($("oauthCallbackInput")) $("oauthCallbackInput").value = "";
      if ($("oauthStatusText")) $("oauthStatusText").textContent = "";
      setOAuthWizardStep(1);
      void refreshOAuthDiscoveryUrl();
    }
    async function copyPlainText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          return ok;
        } catch {
          return false;
        }
      }
    }
    async function refreshOAuthDiscoveryUrl() {
      try {
        const d = await api("/v1/admin/oauth/discovery-url");
        currentDiscoveryUrl = d.discoveryUrl || "";
      } catch {}
    }
    if ($("oauthDiscoveryCopyBtn")) {
      $("oauthDiscoveryCopyBtn").onclick = async () => {
        if (!currentDiscoveryUrl) await refreshOAuthDiscoveryUrl();
        if (!currentDiscoveryUrl) {
          notify(tr("识别链接尚未就绪，请稍后重试。", "Discovery URL not ready, please retry."), true);
          return;
        }
        const btn = $("oauthDiscoveryCopyBtn");
        const copied = await copyPlainText(currentDiscoveryUrl);
        if (copied) {
          btn.textContent = tr("✓ 已复制第 1 步链接", "✓ Step 1 URL Copied");
          notify(tr("已复制第 1 步识别链接，请到已登录该账号的浏览器窗口打开。", "Step 1 URL copied. Open it in your signed-in browser."));
          setTimeout(() => {
            btn.textContent = tr("复制第 1 步链接（识别账号）", "Copy Step 1 URL (Identify Account)");
          }, 2200);
        } else {
          notify(tr("剪贴板复制失败，请检查浏览器权限。", "Clipboard copy failed. Check browser permissions."), true);
        }
      };
    }
    if ($("oauthResetStepBtn")) $("oauthResetStepBtn").onclick = goBackToOAuthStep1;
    if ($("oauthStepPill1")) {
      $("oauthStepPill1").onclick = () => {
        if ($("oauthStepPill1").classList.contains("done")) goBackToOAuthStep1();
      };
    }

    document.querySelectorAll("[data-open-add-modal]").forEach((b) => {
      b.onclick = () => {
        if ($("oauthAccountTypeSelect")) {
          $("oauthAccountTypeSelect").value = "personal";
          syncSelectUi($("oauthAccountTypeSelect"));
        }
        switchAddMode("oauth");
        const savedIssuer = localStorage.getItem("aq_oauth_issuer") || "";
        const savedWsHost = localStorage.getItem("aq_oauth_wshost") || "";
        if ($("oauthIssuerInput") && !$("oauthIssuerInput").value && savedIssuer) $("oauthIssuerInput").value = savedIssuer;
        if ($("oauthWsHostInput") && !$("oauthWsHostInput").value && savedWsHost) $("oauthWsHostInput").value = savedWsHost;
        if ($("oauthDiscoveryCallbackInput")) $("oauthDiscoveryCallbackInput").value = "";
        if ($("oauthCallbackInput")) $("oauthCallbackInput").value = "";
        if ($("oauthStatusText")) $("oauthStatusText").textContent = "";
        if ($("addMoreOptions")) $("addMoreOptions").open = false;
        stopOAuthPoll();
        activeOAuthFlowId = "";
        currentOAuthAuthUrl = "";
        setOAuthWizardStep(1);
        void refreshOAuthDiscoveryUrl();
        $("addModal").classList.add("open");
      };
    });
    if ($("ovViewAllLogsBtn")) $("ovViewAllLogsBtn").onclick = () => switchTab("logs");
    if ($("onboardToKeysBtn")) $("onboardToKeysBtn").onclick = () => switchTab("clientkeys");
    window.closeAddModal = () => { $("addModal").classList.remove("open"); };
    let activeOAuthFlowId = "";
    let oauthPollTimer = null;
    function stopOAuthPoll() {
      if (oauthPollTimer) { clearInterval(oauthPollTimer); oauthPollTimer = null; }
    }
    function normalizeIssuerInput(raw) {
      const s = String(raw || "").trim();
      if (!s) return "";
      const ssoMatch = /ssoins-[a-z0-9]+/i.exec(decodeURIComponent(s.replace(/%(?![0-9A-Fa-f]{2})/g, "%25")));
      if (ssoMatch && !s.startsWith("https://")) {
        return "https://identitycenter.amazonaws.com/" + ssoMatch[0].toLowerCase();
      }
      return s;
    }
    if ($("oauthIssuerInput")) {
      $("oauthIssuerInput").addEventListener("blur", () => {
        const norm = normalizeIssuerInput($("oauthIssuerInput").value);
        if (norm) $("oauthIssuerInput").value = norm;
      });
    }
    if ($("oauthCopyBtn")) {
      $("oauthCopyBtn").onclick = async () => {
        const btn = $("oauthCopyBtn");
        if (!currentOAuthAuthUrl) return;
        const copied = await copyPlainText(currentOAuthAuthUrl);
        if (copied) {
          btn.textContent = tr("✓ 已复制授权链接", "✓ Auth URL Copied");
          notify(tr("已复制授权链接，请在同一个浏览器打开并点击 Allow access。", "Auth URL copied. Open it in the same browser and click Allow access."));
          setTimeout(() => {
            btn.textContent = tr("复制授权链接（去点 Allow access）", "Copy Auth URL (Click Allow access)");
          }, 2200);
        } else {
          notify(tr("剪贴板复制失败，请检查浏览器权限。", "Clipboard copy failed. Check browser permissions."), true);
        }
      };
    }
    if ($("oauthDiscoveryCallbackInput")) {
      $("oauthDiscoveryCallbackInput").addEventListener("input", () => {
        const val = $("oauthDiscoveryCallbackInput").value.trim();
        if (val.includes("issuerUrl=") && val.includes("tenantUrl=") && $("oauthStartBtn") && !$("oauthStartBtn").disabled) {
          $("oauthStartBtn").click();
        }
      });
    }
    if ($("oauthCallbackInput")) {
      $("oauthCallbackInput").addEventListener("input", () => {
        const val = $("oauthCallbackInput").value.trim();
        if (activeOAuthFlowId && val.includes("code=") && val.includes("state=") && $("oauthCompleteBtn") && !$("oauthCompleteBtn").disabled) {
          $("oauthCompleteBtn").click();
        }
      });
    }

    if ($("oauthStartBtn")) {
      $("oauthStartBtn").onclick = async () => {
        const discoveryCallbackUrl = $("oauthDiscoveryCallbackInput") ? $("oauthDiscoveryCallbackInput").value.trim() : "";
        const isEnterprise = $("oauthAccountTypeSelect") && $("oauthAccountTypeSelect").value === "enterprise";
        const issuerUrl = isEnterprise ? normalizeIssuerInput($("oauthIssuerInput").value) : "";
        if (isEnterprise && issuerUrl) $("oauthIssuerInput").value = issuerUrl;
        const wsHost = isEnterprise ? $("oauthWsHostInput").value.trim().replace(/^https?:\\/\\//i, "").replace(/\\/.*$/, "") : "";
        if (isEnterprise && wsHost) $("oauthWsHostInput").value = wsHost;
        if (!discoveryCallbackUrl && (!isEnterprise || !issuerUrl || !wsHost)) {
          notify(tr("请先点击「复制识别链接」在浏览器打开，并把跳转后的地址粘贴到输入框。", "Copy the discovery URL, open it in your browser, and paste the redirected URL first."), true);
          return;
        }
        const label = $("modalLabelInput").value.trim();
        const proxyUrl = $("modalProxyInput") ? $("modalProxyInput").value.trim() : "";
        const chatAgentId = $("modalChatAgentInput") ? $("modalChatAgentInput").value.trim() : "";
        try {
          if (issuerUrl) localStorage.setItem("aq_oauth_issuer", issuerUrl);
          if (wsHost) localStorage.setItem("aq_oauth_wshost", wsHost);
        } catch {}
        $("oauthStartBtn").disabled = true;
        $("oauthStartBtn").textContent = tr("识别中...", "Working...");
        try {
          const r = await api("/v1/admin/oauth/start", {
            method: "POST",
            body: JSON.stringify({
              ...(discoveryCallbackUrl ? { discoveryCallbackUrl } : {}),
              ...(issuerUrl ? { issuerUrl } : {}),
              ...(wsHost ? { wsHost } : {}),
              label: label || undefined,
              proxyUrl: proxyUrl || undefined,
              chatAgentId: chatAgentId || undefined
            })
          });
          activeOAuthFlowId = r.flowId;
          currentOAuthAuthUrl = r.authUrl || "";
          let acctHint = "";
          try {
            const parsed = new URL(discoveryCallbackUrl);
            const acc = parsed.searchParams.get("account") || "";
            if (acc) acctHint = "AWS #" + acc.slice(-4);
          } catch {}
          if (!acctHint && isEnterprise) acctHint = tr("企业工作区", "Enterprise");
          if ($("oauthCallbackInput")) $("oauthCallbackInput").value = "";
          setOAuthWizardStep(2, acctHint);
          if ($("oauthStatusText")) $("oauthStatusText").textContent = tr("授权链接 10 分钟内有效，粘贴回调后自动完成绑定。", "Valid for 10 min · paste callback URL to finish automatically.");
          notify(tr("已识别账号，请点击「复制授权链接」去浏览器同意授权。", "Account detected. Click Copy Auth URL to approve in browser."));
          stopOAuthPoll();
          oauthPollTimer = setInterval(async () => {
            if (!activeOAuthFlowId) return stopOAuthPoll();
            try {
              const st = await api("/v1/admin/oauth/status?flowId=" + encodeURIComponent(activeOAuthFlowId));
              if (st.status === "completed") {
                stopOAuthPoll();
                activeOAuthFlowId = "";
                currentOAuthAuthUrl = "";
                if ($("oauthStatusText")) $("oauthStatusText").textContent = tr("授权成功，已自动入池！", "Authorized & added!");
                closeAddModal();
                notify(tr("OAuth 90天自动续期凭证已成功入池。", "OAuth 90-day credential added."));
                await loadConsoleData("?force=1");
              } else if (st.status === "error") {
                stopOAuthPoll();
                if ($("oauthStatusText")) $("oauthStatusText").textContent = st.error || "Error";
              }
            } catch {}
          }, 2000);
        } catch (e) {
          notify(e.message, true);
        } finally {
          $("oauthStartBtn").disabled = false;
          $("oauthStartBtn").textContent = tr("下一步", "Next");
        }
      };
    }
    if ($("oauthCompleteBtn")) {
      $("oauthCompleteBtn").onclick = async () => {
        const cb = $("oauthCallbackInput").value.trim();
        if (!activeOAuthFlowId || !cb) {
          notify(tr("请先点击「浏览器一键授权登录」并粘贴回调 URL。", "Start OAuth login first and paste the callback URL."), true);
          return;
        }
        $("oauthCompleteBtn").disabled = true;
        try {
          const label = $("modalLabelInput").value.trim();
          const proxyUrl = $("modalProxyInput") ? $("modalProxyInput").value.trim() : "";
          const chatAgentId = $("modalChatAgentInput") ? $("modalChatAgentInput").value.trim() : "";
          await api("/v1/admin/oauth/complete", {
            method: "POST",
            body: JSON.stringify({ flowId: activeOAuthFlowId, callbackUrl: cb, label: label || undefined, proxyUrl: proxyUrl || undefined, chatAgentId: chatAgentId || undefined })
          });
          stopOAuthPoll();
          activeOAuthFlowId = "";
          $("oauthCallbackInput").value = "";
          closeAddModal();
          notify(tr("OAuth 90天自动续期凭证已成功入池。", "OAuth 90-day credential added."));
          await loadConsoleData("?force=1");
        } catch (e) {
          notify(e.message, true);
        } finally {
          $("oauthCompleteBtn").disabled = false;
        }
      };
    }

    if ($("importJsonFileBtn") && $("importJsonFileInput")) {
      $("importJsonFileBtn").onclick = () => $("importJsonFileInput").click();
      $("importJsonFileInput").onchange = async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          if ($("modalBatchJsonInput")) $("modalBatchJsonInput").value = text;
          let countHint = "";
          try {
            const p = JSON.parse(text);
            const arr = Array.isArray(p) ? p : (p && Array.isArray(p.credentials) ? p.credentials : []);
            if (arr.length > 0) countHint = tr("（共 " + arr.length + " 条凭证）", " (" + arr.length + " credentials)");
          } catch {}
          if ($("batchFileStatusLabel")) {
            $("batchFileStatusLabel").textContent = tr("已选择：", "Selected: ") + file.name + countHint;
          }
          notify(tr("已读取 JSON 文件" + countHint + "，点击右下角按钮即可完成导入。", "JSON file loaded" + countHint + ". Click Batch Import to confirm."));
        } catch (e) {
          notify(e.message, true);
        } finally {
          $("importJsonFileInput").value = "";
        }
      };
    }

    $("confirmAddKeyBtn").onclick = async () => {
      if (activeAddMode === "batch") {
        const batchRaw = $("modalBatchJsonInput") ? $("modalBatchJsonInput").value.trim() : "";
        if (!batchRaw) {
          notify(tr("请先选择 .json 备份文件或粘贴 JSON 内容。", "Please choose a .json backup file or paste JSON content first."), true);
          return;
        }
        $("confirmAddKeyBtn").disabled = true;
        try {
          let parsed;
          try {
            parsed = JSON.parse(batchRaw);
          } catch {
            throw new Error(tr("内容不是有效的 JSON 格式。", "Invalid JSON syntax."));
          }
          const r = await api("/v1/admin/keys/import-json", { method: "POST", body: JSON.stringify(parsed) });
          if ($("modalBatchJsonInput")) $("modalBatchJsonInput").value = "";
          if ($("batchFileStatusLabel")) $("batchFileStatusLabel").textContent = tr("上传 JSON 备份文件", "Upload JSON backup file");
          closeAddModal();
          notify(tr("已从 JSON 备份成功导入 " + (r.imported || 0) + " 条凭证并同步额度。", "Imported " + (r.imported || 0) + " credential(s) from JSON."));
          await loadConsoleData("?force=1");
        } catch (e) {
          notify(tr("批量导入失败: ", "Batch import failed: ") + e.message, true);
        } finally {
          $("confirmAddKeyBtn").disabled = false;
        }
        return;
      }
      const rawInput = $("modalKeysInput").value.trim();
      if (!rawInput) {
        notify(tr("请先粘贴 Cookie 请求（Copy as cURL）或已有凭证。", "Please paste a Cookie request (Copy as cURL) or raw credential first."), true);
        return;
      }
      if (rawInput.startsWith("{") || rawInput.startsWith("[")) {
        $("confirmAddKeyBtn").disabled = true;
        try {
          const parsed = JSON.parse(rawInput);
          const r = await api("/v1/admin/keys/import-json", { method: "POST", body: JSON.stringify(parsed) });
          $("modalKeysInput").value = "";
          closeAddModal();
          notify(tr("已从 JSON 备份成功恢复 " + (r.imported || 0) + " 条凭证。", "Restored " + (r.imported || 0) + " credential(s) from JSON."));
          await loadConsoleData("?force=1");
        } catch (e) {
          notify(tr("JSON 备份导入失败: ", "JSON import failed: ") + e.message, true);
        } finally {
          $("confirmAddKeyBtn").disabled = false;
        }
        return;
      }
      const lines = (/quick\.aws\.com/i.test(rawInput) && /aws-ds-access-token=/i.test(rawInput))
        ? [rawInput]
        : rawInput.split(/\\r?\\n|,/).map((s) => s.trim()).filter(Boolean);
      const label = $("modalLabelInput").value.trim();
      const proxyUrl = $("modalProxyInput") ? $("modalProxyInput").value.trim() : "";
      const chatAgentId = $("modalChatAgentInput") ? $("modalChatAgentInput").value.trim() : "";
      const enabled = $("modalEnabledSelect").value === "true";
      $("confirmAddKeyBtn").disabled = true;
      try {
        for (let i = 0; i < lines.length; i++) {
          const itemLabel = lines.length > 1 && label ? (label + " #" + (i + 1)) : label;
          await api("/v1/admin/keys", {
            method: "POST",
            body: JSON.stringify({ apiKey: lines[i], enabled, label: itemLabel, proxyUrl: proxyUrl || undefined, chatAgentId: chatAgentId || undefined })
          });
        }
        $("modalKeysInput").value = "";
        $("modalLabelInput").value = "";
        if ($("modalProxyInput")) $("modalProxyInput").value = "";
        if ($("modalChatAgentInput")) $("modalChatAgentInput").value = "";
        closeAddModal();
        notify(tr("成功导入 " + lines.length + " 把凭证。", "Imported " + lines.length + " key(s)."));
        await loadConsoleData(enabled ? "?force=1" : "");
      } catch (e) {
        notify(e.message, true);
      } finally {
        $("confirmAddKeyBtn").disabled = false;
      }
    };

    if ($("credClearSessionsBtn")) {
      $("credClearSessionsBtn").onclick = async () => {
        const btn = $("credClearSessionsBtn");
        const ids = [...selectedCredIds];
        const totalCount = ids.length > 0 ? ids.length : poolSlotsCache.length;
        if (!totalCount) return notify(tr("当前没有可清理的账号。", "No accounts available to clear."), true);
        const ok = await uiConfirm({
          title: ids.length > 0
            ? tr("清理所选账号云端会话", "Clear Selected Cloud Sessions")
            : tr("清理全部账号云端会话", "Clear All Cloud Sessions"),
          desc: ids.length > 0
            ? tr("确认一键清理已勾选的 " + ids.length + " 个账号在 AWS Quick 云端的全部历史会话吗？此操作不可恢复。", "Clear all cloud chat sessions for the " + ids.length + " selected account(s)? This cannot be undone.")
            : tr("未勾选账号，将默认清理全部 " + totalCount + " 个账号在 AWS Quick 云端的历史会话。确认继续吗？", "No accounts selected. Clear cloud chat sessions for all " + totalCount + " account(s)?"),
          okText: tr("确认清理", "Clear"),
          danger: true
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = tr("清理中...", "Clearing...");
        const targetIds = ids.length > 0 ? ids : poolSlotsCache.map((s) => s.slotId);
        targetIds.forEach((id) => busyClearIds.add(id));
        setCredPanelLoading();
        renderCredTable();
        try {
          const r = await api("/v1/admin/keys/clear-cloud-sessions", {
            method: "POST",
            body: JSON.stringify(ids.length > 0 ? { slotIds: ids } : {})
          });
          const totalDeleted = Number(r.totalDeleted || 0);
          const okCount = Number(r.okCount || 0);
          const failedCount = Number(r.failedCount || 0);
          if (failedCount === 0) {
            notify(tr(
              "清理完成：共删除 " + totalDeleted + " 条云端会话（" + okCount + " 个账号成功）。",
              "Cleared " + totalDeleted + " cloud session(s) across " + okCount + " account(s)."
            ));
          } else {
            const firstErr = String((Array.isArray(r.results) ? r.results.find((x) => x.status === "error")?.error : "") || tr("未知错误", "Unknown error")).slice(0, 120);
            notify(tr(
              "清理完成：共删除 " + totalDeleted + " 条，成功 " + okCount + " 个，失败 " + failedCount + " 个（" + firstErr + "）",
              "Cleared " + totalDeleted + " session(s): " + okCount + " succeeded, " + failedCount + " failed (" + firstErr + ")"
            ), true);
          }
          if (r.keyPool && Array.isArray(r.keyPool.slots)) {
            poolSlotsCache = r.keyPool.slots;
          }
          targetIds.forEach((id) => busyClearIds.delete(id));
          setCredPanelLoading();
          renderCredTable();
          await loadConsoleData("");
        } catch (e) {
          notify(tr("清理失败: ", "Clear failed: ") + e.message, true);
        } finally {
          targetIds.forEach((id) => busyClearIds.delete(id));
          setCredPanelLoading();
          btn.disabled = false;
          btn.textContent = selectedCredIds.size > 0
            ? tr("清理所选会话 (" + selectedCredIds.size + ")", "Clear Sessions (" + selectedCredIds.size + ")")
            : tr("清理会话", "Clear Sessions");
          renderCredTable();
        }
      };
    }

    if ($("cfgIncognitoMode")) {
      $("cfgIncognitoMode").onchange = async () => {
        const wantOn = $("cfgIncognitoMode").checked;
        try {
          await api("/v1/admin/settings", {
            method: "POST",
            body: JSON.stringify({ incognitoMode: wantOn })
          });
          notify(wantOn
            ? tr("已开启无痕隐私模式（不保留云端对话记录）。", "Incognito Privacy Mode enabled (cloud history disabled).")
            : tr("已关闭无痕隐私模式（新对话将保留在 AWS Quick 云端历史中）。", "Incognito Privacy Mode disabled (new chats will be saved in AWS Quick cloud history)."));
        } catch (e) {
          $("cfgIncognitoMode").checked = !wantOn;
          notify(e.message, true);
        }
      };
    }

    if ($("resetAgentPromptBtn")) {
      $("resetAgentPromptBtn").onclick = () => {
        if ($("cfgCustomAgentPrompt")) {
          $("cfgCustomAgentPrompt").value = window.__defaultCustomAgentPrompt || "";
        }
      };
    }

    $("saveRoutingBtn").onclick = async () => {
      try {
        const promptVal = $("cfgCustomAgentPrompt") ? $("cfgCustomAgentPrompt").value.trim() : "";
        const isBuiltInDefault = promptVal === (window.__defaultCustomAgentPrompt || "").trim();
        await api("/v1/admin/settings", {
          method: "POST",
          body: JSON.stringify({
            lbStrategy: $("cfgLbStrategy").value,
            sessionAffinityEnabled: $("cfgAffinityEnabled").checked,
            sessionAffinityTtlSeconds: Number($("cfgAffinityTtl").value) || 3600,
            autoDisableExhaustedKeys: $("cfgAutoDisable").checked,
            incognitoMode: $("cfgIncognitoMode") ? $("cfgIncognitoMode").checked : true,
            autoEnsureCodingAgent: $("cfgAutoEnsureCodingAgent") ? $("cfgAutoEnsureCodingAgent").checked : true,
            customAgentPrompt: isBuiltInDefault ? "" : promptVal
          })
        });
        notify(tr("路由、粘性亲和与 Agent 模板策略已热更新生效。", "Routing, affinity, and agent template settings saved."));
        await loadConsoleData("");
      } catch (e) { notify(e.message, true); }
    };

    $("clearAffinityBtn").onclick = async () => {
      try {
        await api("/v1/admin/affinity/clear", { method: "POST", body: "{}" });
        notify(tr("已清空活跃会话亲和绑定表。", "Active sticky session bindings cleared."));
        await loadConsoleData("");
      } catch (e) { notify(e.message, true); }
    };

    $("pgSendBtn").onclick = async () => {
      const model = $("pgModel").value;
      const promptText = $("pgPrompt").value.trim();
      if (!promptText) return;
      $("pgSendBtn").disabled = true;
      $("pgOutput").textContent = tr("请求调度中...", "Dispatching request...");
      const t0 = performance.now();
      try {
        const res = await api("/v1/admin/playground", {
          method: "POST",
          body: JSON.stringify({ model, prompt: promptText })
        });
        const dt = ((performance.now() - t0) / 1000).toFixed(2);
        const msg = ((res.choices || [])[0] || {}).message || {};
        const routed = res.system_fingerprint ? (" → " + String(res.system_fingerprint).replace(/^us\.anthropic\./, "")) : "";
        $("pgOutput").textContent =
          tr("耗时: ", "Duration: ") + dt + tr("s | 模型: ", "s | Model: ") + res.model + routed + "\\n" +
          (msg.reasoning_content ? (tr("思考: ", "Thinking: ") + msg.reasoning_content.trim() + "\\n\\n") : "") +
          tr("回复: ", "Reply: ") + (msg.content || "") + "\\n\\n" +
          tr("Token 统计: ", "Usage: ") + JSON.stringify(res.usage || {});
        notify(tr("在线测试完成（" + dt + "s" + routed + "）。", "Test completed (" + dt + "s" + routed + ")."));
        await loadConsoleData("");
      } catch (e) {
        $("pgOutput").textContent = tr("请求失败: ", "Request failed: ") + e.message;
      } finally {
        $("pgSendBtn").disabled = false;
      }
    };

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (openTraceId) closeTraceDrawer();
      else if ($("updateModal") && $("updateModal").classList.contains("open")) window.closeUpdateModal();
      else if ($("addModal").classList.contains("open")) window.closeAddModal();
      else if ($("clientKeyModal").classList.contains("open")) window.closeCkModal();
    });

    // CSP-safe event delegation (replaces inline onclick/onchange attributes).
    function dispatchDataAction(ev, attr) {
      const el = ev.target.closest("[data-" + attr + "]");
      if (!el) return;
      const fn = window[el.getAttribute("data-" + attr)];
      if (typeof fn !== "function") return;
      if (el.hasAttribute("data-pass")) { fn(el); return; }
      if (el.hasAttribute("data-arg2")) { fn(el.dataset.arg, el.dataset.arg2); return; }
      if (attr === "change") { fn(el.dataset.arg, el.checked); return; }
      if (el.hasAttribute("data-arg")) { fn(el.dataset.arg); return; }
      fn();
    }
    document.addEventListener("click", (ev) => {
      const self = ev.target.closest("[data-click-self]");
      if (self && ev.target === self) { const f = window[self.getAttribute("data-click-self")]; if (typeof f === "function") f(); return; }
      if (ev.target.closest("input,label")) return;
      dispatchDataAction(ev, "click");
    });
    document.addEventListener("change", (ev) => dispatchDataAction(ev, "change"));

    applyLang(currentLang);

    (async () => {
      try {
        const setupRes = await fetch(basePath + "/v1/admin/setup-status", { credentials: "same-origin" });
        const setupData = setupRes.ok ? await setupRes.json().catch(() => ({})) : {};
        if (setupData && setupData.needsSetup) {
          applyLoginGateMode(true);
          showLoginGate();
          return;
        }
        applyLoginGateMode(false);
        const st = await fetch(basePath + "/v1/admin/session", {
          credentials: "same-origin",
          headers: Object.assign({ "X-Console-Lang": currentLang }, sessionBearer ? { Authorization: "Bearer " + sessionBearer } : {})
        });
        if (st.ok) {
          showConsole();
          const savedTab = lsGet("aq_active_tab");
          if (savedTab && tabTitles[savedTab] && savedTab !== "overview") {
            switchTab(savedTab);
          }
          await loadConsoleData("");
          void checkAppVersion(false);
        } else {
          showLoginGate();
        }
      } catch {
        applyLoginGateMode(false);
        showLoginGate();
      }
    })();

    let cachedVersionInfo = null;
    window.closeUpdateModal = () => { if ($("updateModal")) $("updateModal").classList.remove("open"); };
    function renderUpdateModal(v) {
      if (!$("updateModalBody") || !v) return;
      const lines = [];
      lines.push('<div><strong>' + esc(tr('当前版本：', 'Current version: ')) + '</strong><span class="mono">v' + esc(v.currentVersion) + '</span></div>');
      if (v.repo) {
        lines.push('<div><strong>' + esc(tr('GitHub 仓库：', 'GitHub repo: ')) + '</strong><span class="mono">' + esc(v.repo) + '</span></div>');
        if (v.latestVersion) {
          lines.push('<div><strong>' + esc(tr('最新版本：', 'Latest release: ')) + '</strong><span class="mono" style="color:' + (v.hasUpdate ? 'var(--ok)' : 'var(--fg)') + ';">v' + esc(v.latestVersion) + '</span>' +
            (v.hasUpdate ? ' <span class="tag tag-ok">' + esc(tr('有可用更新', 'Update Available')) + '</span>' : ' <span class="tag">' + esc(tr('已是最新', 'Up to date')) + '</span>') + '</div>');
        }
      } else {
        lines.push('<div style="color:var(--fg-muted);">' + esc(tr('已通过 UPDATE_CHECK_REPO=off 关闭 GitHub Releases 版本检测。移除该配置即可恢复默认检测。', 'GitHub Releases check is disabled via UPDATE_CHECK_REPO=off. Remove it to re-enable.')) + '</div>');
      }
      if (v.releaseNotes) {
        lines.push('<div style="margin-top:8px;"><strong>' + esc(tr('更新日志：', 'Release Notes:')) + '</strong><pre class="code-block mono" style="max-height:180px;overflow:auto;white-space:pre-wrap;">' + esc(v.releaseNotes) + '</pre></div>');
      }
      lines.push('<div style="margin-top:10px;"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;"><strong>' + esc(tr('升级命令参考：', 'Upgrade Commands:')) + '</strong>' +
        '<div style="display:flex;gap:6px;">' +
        '<button type="button" class="btn btn-sm" id="copyDockerUpgradeBtn">' + esc(tr('复制 Docker 升级命令', 'Copy Docker Upgrade')) + '</button>' +
        '<button type="button" class="btn btn-sm" id="copySourceUpgradeBtn">' + esc(tr('复制源码升级命令', 'Copy Source Upgrade')) + '</button>' +
        '</div></div>' +
        '<pre class="code-block mono" style="margin-top:6px;"># Docker\\ndocker compose pull && docker compose up -d\\n\\n# Source\\ngit pull && npm ci && npm run build</pre></div>');
      if (v.releaseUrl && (String(v.releaseUrl).startsWith("https://") || String(v.releaseUrl).startsWith("http://"))) {
        lines.push('<div style="margin-top:6px;"><a href="' + esc(v.releaseUrl) + '" target="_blank" rel="noopener" style="color:var(--cta-bg);text-decoration:underline;">' + esc(tr('前往 GitHub Release 页面查看详情 →', 'View on GitHub Releases →')) + '</a></div>');
      }
      $("updateModalBody").innerHTML = lines.join("");
      const copyCmd = async (cmd, label) => {
        try {
          await navigator.clipboard.writeText(cmd);
          notify(tr("已复制 " + label + " 升级命令，在服务器终端执行即可完成升级。", "Copied " + label + " upgrade command."));
        } catch {
          notify(tr("复制失败，请手动复制下方命令。", "Copy failed, please copy manually."), true);
        }
      };
      if ($("copyDockerUpgradeBtn")) {
        $("copyDockerUpgradeBtn").onclick = () => void copyCmd("docker compose pull && docker compose up -d", "Docker");
      }
      if ($("copySourceUpgradeBtn")) {
        $("copySourceUpgradeBtn").onclick = () => void copyCmd("git pull && npm ci && npm run build", tr("源码", "Source"));
      }
    }
    async function checkAppVersion(force) {
      try {
        const v = await api("/v1/admin/version" + (force ? "?force=1" : ""));
        cachedVersionInfo = v;
        if ($("sidebarBrandVer") && v.currentVersion) {
          $("sidebarBrandVer").textContent = "v" + v.currentVersion;
        }
        const btn = $("versionPillBtn");
        if (btn) {
          btn.style.display = "inline-flex";
          if (v.hasUpdate && v.latestVersion) {
            btn.style.color = "var(--ok)";
            btn.style.borderColor = "var(--ok)";
            btn.textContent = tr("新版本 v", "New v") + v.latestVersion;
          } else {
            btn.style.color = "";
            btn.style.borderColor = "";
            btn.textContent = "v" + v.currentVersion;
          }
          btn.onclick = () => {
            renderUpdateModal(cachedVersionInfo);
            $("updateModal").classList.add("open");
          };
        }
        if (force && $("updateModal").classList.contains("open")) {
          renderUpdateModal(v);
          notify(v.hasUpdate ? tr("发现新版本 v" + v.latestVersion, "Update available: v" + v.latestVersion) : tr("当前已是最新版本。", "You are up to date."));
        }
      } catch {}
    }
    if ($("recheckVersionBtn")) {
      $("recheckVersionBtn").onclick = () => void checkAppVersion(true);
    }
  </script>
</body>
</html>`;
}
