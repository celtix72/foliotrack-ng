const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ICONS_DIR = path.join(__dirname, '..', '..', 'public', 'icons');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

// 1. Standard SVG Icon (rounded squircle)
const standardSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="brandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10B981"/>
      <stop offset="60%" stop-color="#059669"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#34D399"/>
      <stop offset="100%" stop-color="#A7F3D0"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#022c22" flood-opacity="0.45"/>
    </filter>
  </defs>

  <!-- Base Rounded Squircle -->
  <rect width="512" height="512" rx="112" fill="url(#brandGrad)"/>

  <!-- Inner Highlighting Ring -->
  <rect x="6" y="6" width="500" height="500" rx="106" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="4"/>

  <!-- Decorative Financial Chart Bars in Background -->
  <g opacity="0.14">
    <rect x="90" y="320" width="44" height="90" rx="8" fill="#FFFFFF"/>
    <rect x="154" y="270" width="44" height="140" rx="8" fill="#FFFFFF"/>
    <rect x="218" y="210" width="44" height="200" rx="8" fill="#FFFFFF"/>
    <rect x="282" y="150" width="44" height="260" rx="8" fill="#FFFFFF"/>
    <rect x="346" y="90" width="44" height="320" rx="8" fill="#FFFFFF"/>
  </g>

  <!-- Central Dynamic Arrow & Symbol -->
  <g filter="url(#softShadow)">
    <!-- Upward Trend Line -->
    <path d="M 104 360 L 210 254 L 284 308 L 396 172" fill="none" stroke="url(#accentGrad)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Arrow Head -->
    <polygon points="408,136 418,206 352,186" fill="#A7F3D0"/>

    <!-- FT Typography Monogram -->
    <text x="256" y="380" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Inter', sans-serif" font-size="160" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="-5">FT</text>
  </g>
</svg>`;

// 2. Maskable SVG Icon (Full Bleed square background with logo in safe zone: 80% circle)
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="maskGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10B981"/>
      <stop offset="50%" stop-color="#059669"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="maskAccent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#34D399"/>
      <stop offset="100%" stop-color="#A7F3D0"/>
    </linearGradient>
    <filter id="maskShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#022c22" flood-opacity="0.4"/>
    </filter>
  </defs>

  <!-- Full-bleed background for Android Adaptive Icons -->
  <rect width="512" height="512" fill="url(#maskGrad)"/>

  <!-- Content scaled inside 80% Safe Zone (radius ~204 around 256, 256) -->
  <g transform="translate(51.2, 51.2) scale(0.8)">
    <!-- Decorative Chart Bars -->
    <g opacity="0.14">
      <rect x="90" y="320" width="44" height="90" rx="8" fill="#FFFFFF"/>
      <rect x="154" y="270" width="44" height="140" rx="8" fill="#FFFFFF"/>
      <rect x="218" y="210" width="44" height="200" rx="8" fill="#FFFFFF"/>
      <rect x="282" y="150" width="44" height="260" rx="8" fill="#FFFFFF"/>
      <rect x="346" y="90" width="44" height="320" rx="8" fill="#FFFFFF"/>
    </g>

    <g filter="url(#maskShadow)">
      <!-- Upward Trend Line -->
      <path d="M 104 360 L 210 254 L 284 308 L 396 172" fill="none" stroke="url(#maskAccent)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
      <polygon points="408,136 418,206 352,186" fill="#A7F3D0"/>
      <!-- Monogram -->
      <text x="256" y="380" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Inter', sans-serif" font-size="160" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="-5">FT</text>
    </g>
  </g>
</svg>`;

// Write SVGs
fs.writeFileSync(path.join(ICONS_DIR, 'icon.svg'), standardSvg);
fs.writeFileSync(path.join(ICONS_DIR, 'icon-maskable.svg'), maskableSvg);
fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.svg'), standardSvg);

console.log('SVGs written successfully.');

// Rasterize to PNG using sips on macOS or fallback
try {
  const icon512Path = path.join(ICONS_DIR, 'icon-512.png');
  const icon192Path = path.join(ICONS_DIR, 'icon-192.png');
  const maskable512Path = path.join(ICONS_DIR, 'icon-maskable-512.png');
  const maskable192Path = path.join(ICONS_DIR, 'icon-maskable-192.png');
  const faviconIcoPath = path.join(PUBLIC_DIR, 'favicon.ico');

  // Convert standard 512
  execSync(`sips -s format png "${path.join(ICONS_DIR, 'icon.svg')}" --out "${icon512Path}"`, { stdio: 'ignore' });
  // Resize to 192
  execSync(`sips -s format png "${icon512Path}" --resampleWidth 192 --out "${icon192Path}"`, { stdio: 'ignore' });

  // Convert maskable 512
  execSync(`sips -s format png "${path.join(ICONS_DIR, 'icon-maskable.svg')}" --out "${maskable512Path}"`, { stdio: 'ignore' });
  // Resize maskable to 192
  execSync(`sips -s format png "${maskable512Path}" --resampleWidth 192 --out "${maskable192Path}"`, { stdio: 'ignore' });

  // Create favicon.ico (16x16 / 32x32)
  const faviconPng = path.join(PUBLIC_DIR, 'favicon-32.png');
  execSync(`sips -s format png "${icon192Path}" --resampleWidth 32 --out "${faviconPng}"`, { stdio: 'ignore' });
  // copy or format as ico
  fs.copyFileSync(faviconPng, faviconIcoPath);

  console.log('PNG and ICO icons rasterized successfully via sips:');
  console.log(' - icon-512.png (512x512)');
  console.log(' - icon-192.png (192x192)');
  console.log(' - icon-maskable-512.png (512x512)');
  console.log(' - icon-maskable-192.png (192x192)');
  console.log(' - favicon.ico');
} catch (err) {
  console.error('Rasterization error:', err.message);
}

