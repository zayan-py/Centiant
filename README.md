# Centiant 🚀

Centiant is a high-speed automation and solving tool for the Century Tech platform. It combines Playwright-based browser automation with OpenAI's GPT-4o to provide accurate, distributed solving for various question types, including complex drag-and-drop matching.

## ✨ Features

- **Multi-Tab Dashboard:** A dual-tab interface with a live GUI on one side and the automated Century Tech session on the other.
- **Advanced Matching Logic:** Custom `safeDrag` implementation with a 3-attempt verification loop to ensure 100% completion on matching questions.
- **Intelligent Scraping:** Robust nugget detection with white-screen recovery and multi-attempt retry logic.
- **Comprehensive Question Support:** Handles Multiple Choice (MCQ), Text Input, and Drag & Drop questions.
- **Security-First:** Credential management via environment variables (`.env`) to keep your API keys and login details out of version control.
- **Detailed Analytics:** Tracks accuracy and provides a live queue of nuggets to be solved.

## 🛠️ Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- NPM (comes with Node)
- An OpenAI API Key

## 🚀 Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/zayan-py/Centiant.git
   cd Centiant
   ```

2. **Install dependencies:**
   ```bash
   npm install
   npx playwright install chromium
   ```

## ⚙️ Configuration

1. **Setup Environment Variables:**
   Rename `.env.example` to `.env` and fill in your details:
   ```bash
   cp .env.example .env
   ```
   Edit `.env`:
   ```env
   OPENAI_API_KEY=your_openai_key_here
   CENTURY_USERNAME=your_username
   CENTURY_PASSWORD=your_password
   ```

## 🎯 Usage

To start Centiant, simply run the batch file:
```bash
run.bat
```
Alternatively, launch it via Node:
```bash
node century_solver.js
```

## 🛡️ License

This project is licensed under the ISC License.
