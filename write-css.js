const fs = require('fs');
const css = `
:root {
  --bg: #0f1115;
  --surface: #161a20;
  --border: #2a2f36;
  --text: #e6edf3;
  --text-secondary: #9da7b3;
  --primary: #2f81f7;
  --primary-hover: #388bfd;
  --danger: #f85149;
  --danger-hover: #da3633;
  --radius: 6px;
  --font-ui: 'Inter', -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-ui);
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}

.layout-app {
  display: grid;
  grid-template-columns: 250px 1fr;
  height: 100vh;
}

/* Sidebar */
.layout-sidebar {
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--border);
}

.sidebar-logo {
  width: 24px;
  height: 24px;
  color: var(--text);
}

.sidebar-brand {
  font-weight: 600;
  font-size: 14px;
}

.sidebar-nav {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar-bottom {
  margin-top: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: 13px;
  text-align: left;
  transition: all 0.2s;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}

.nav-item.active {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}

/* Main Area */
.layout-main {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.sys-header {
  height: 64px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-search {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 12px;
  width: 300px;
}

.header-search svg {
  color: var(--text-secondary);
}

.search-input {
  background: transparent;
  border: none;
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 13px;
  width: 100%;
  outline: none;
}

.search-input::placeholder {
  color: var(--text-secondary);
}

.sys-content {
  flex: 1;
  padding: 32px;
  overflow-y: auto;
}

/* VM Cards */
.vm-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid transparent; /* Managed by JS */
  border-radius: var(--radius);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 16px;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 6px 14px;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}

.btn:hover {
  background: rgba(255, 255, 255, 0.05);
}

.btn-primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

.btn-primary:hover {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
}

.btn-danger {
  color: var(--danger);
  border-color: var(--border);
}

.btn-danger:hover {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}
`;
fs.writeFileSync('renderer/styles.css', css, 'utf8');
console.log('styles.css rewritten successfully.');
