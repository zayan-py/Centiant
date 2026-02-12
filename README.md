# Century Tech Solver (Standalone)

A sophisticated automation tool for solving Century Tech assignments using AI-powered vision and reasoning.

## 🚀 Setup

1.  **Clone/Download** this repository to your local machine.
2.  **Configuration**: Open `config.json` and enter your OpenAI API key and Century Tech credentials.
    ```json
    {
      "openai_api_key": "your-key-here",
      "century_username": "your-username",
      "century_password": "your-password"
    }
    ```
3.  **Dependencies**: Run `npm install` to install Playwright and other required packages.
4.  **Launch**: Run `node index.js` to start the backend and the GUI.

## 🕹️ Usage

1.  **Login**: Click the "LOGIN TO CENTURY" button in the GUI.
2.  **Assignment**: Once logged in, navigate to an assignment or paste an assignment URL into the input field and click "START FLOW".
3.  **Auto-Solve**: Ensure the "Auto-Solve" checkbox is checked for the solver to automatically process questions.
4.  **Speeds**: Adjust the Delay Level (Short/Medium/Long) to control how "human-like" the automation behavior is.

## 🛡️ Best Practices & Safety

- **Use "Long" Delays**: This makes the automation more human-like and reduces the risk of detection.
- **Manual Intervention**: The solver will warn you if it stalls. If you see a "STALL WARNING", manually complete the current question.
- **Verification**: The solver now includes a verification pass for drag-and-drop questions to ensure all items are placed correctly.

## 🛠️ Features

- **Multimodal AI**: Uses GPT-4o vision to analyze diagrams and complex images.
- **Robust Drag & Drop**: Includes a jitter-based drag system and post-drag verification.
- **Nugget Scraper**: Automatically identifies and queues up uncompleted nuggets within an assignment.
- **Blank Page Recovery**: Smarter navigation that detects and refreshes blank/broken pages.
