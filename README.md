# Centiant 🚀

Centiant is a high-speed automation and solving tool for the Century Tech platform. It combines Playwright-based browser automation with OpenAI's GPT-4o to provide accurate, distributed solving across multiple interfaces.

## 🌟 Interface Modes

Centiant can be operated in two distinct ways:

### 1. Discord Bot (Main)
A multi-user bot that allows you to manage assignments, scan for due work, and solve nuggets remotely via Discord commands. Features include:
- **Redemption System**: Access control via 12-digit keys.
- **Account Locking**: Securely link your Century credentials to your Discord ID.
- **Assignment Browser**: View due assignments and specific nuggets directly in Discord.
- **Live Monitoring**: High-speed solver reporting progress and scores via embeds.

### 2. Standalone GUI (Inside `/gui`)
A local browser-based dashboard intended for individual use. 
- **Dual Tabs**: Watch the solver work in real-time alongside a live control panel.
- **Manual Control**: Directly manage the solver flight from your desktop.

---

## 🛠️ Prerequisites

- **Python 3.10+** (For the Discord Bot)
- **Node.js v18+** (For the Solver Engine)
- **Playwright** (Browser automation)
- **OpenAI API Key** (For AI-powered solving)

## 🚀 Installation

1. **Clone & Enter Folder**
   ```bash
   git clone https://github.com/zayan-py/Centiant.git
   cd Centiant
   ```

2. **Install Engine Dependencies (Node.js)**
   ```bash
   npm install
   npx playwright install chromium
   ```

3. **Install Bot Dependencies (Python)**
   ```bash
   pip install -r requirements.txt
   ```

4. **Environment Setup**
   Rename `.env.example` to `.env` and fill in your details:
   - `DISCORD_TOKEN`: Your bot token from the [Discord Developer Portal](https://discord.com/developers/applications).
   - `OPENAI_API_KEY`: Your OpenAI key.

---

## 🎯 Usage

### Running the Discord Bot
```bash
python bot.py
```

### Running the Standalone GUI
Navigate to the `gui` folder and run:
```bash
gui/run.bat
```

---

## 📁 Repository Structure

```text
Centiant/
├── gui/                # Standalone GUI files (index.html, css)
├── bot.py              # Main Discord Bot script
├── century_solver.js   # The core automation engine
├── scraper.js          # Assignment/Nugget scanner
├── auth_check.js       # Credential validator
├── database.py         # SQLite user management
└── keys.csv            # (Ignored) Access keys
```

## 🛡️ Privacy & Security
- **Strict .gitignore**: User databases (`users.db`), sensitive credentials (`.env`), and access keys (`keys.csv`) are strictly excluded from the repository.
- **Headless Mode**: The bot runs in headless mode to maximize server resources.

## ⚖️ License
This project is for educational and testing purposes only. Use responsibly.
