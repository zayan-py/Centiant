# Century Solver Changelog

## [1.4.0] - 2026-02-25

### Added
- **Full-Page Vision:** The solver now captures the entire viewport for questions with images, providing much better visual context to the AI for diagrams and labels.
- **Turbo Mode Toggle:** Replaced the granular slider with a simple binary toggle for instant switching between "Standard" (reliable) and "Max Turbo" (effectively instant) speeds.
- **Redundancy & Autonomy:**
  - **Stuck Question Watchdog:** Implemented a hard 90-second wall-clock timer that automatically skips questions via "I Don't Know" if stuck.
  - **Stale Page Recovery:** Added a watchdog that reloads the page automatically if no meaningful activity is detected for 2 minutes.
  - **Auto-Terminate:** The script now cleanly closes the browser and terminates the process after all nuggets in the queue are finished.
  - **Session Reporting:** Added an end-of-session summary in the GUI and console showing total nuggets completed, average accuracy, and total time elapsed.
  - **Navigation Retries:** Nugget loading now retries up to 3 times with 5s gaps to handle temporary network failures.
- **AI Rate Limit Handling:** Implemented a recursive back-off mechanism (10s wait) for OpenAI rate limit errors (429) across all question types.

### Changed
- **Brute-Force Clicking:** Updated `safeClick` and navigation logic to use JS-injection evaluation for clicking. This makes "Next Question" and "Submit" buttons much more responsive.
- **Refined MCQ Prompting:** Optimized prompts to prioritize 1-based index responses for MCQs, improving accuracy and reducing token costs.
- **Expanded Matching Selectors:** Added support for `.rc-prompt-answer-pair` layouts, common in biology and diagram-based questions.

### Fixed
- **Fuzzy Matching Logic:** Improved row matching for matching questions by stripping symbols (like `->`) and extra whitespace, resolving cases where labels were ignored.
- **False-Positive Skips:** Fixed a bug where matching questions were skipped prematurely due to incomplete label text detection.


## [1.3.0] - 2026-02-17

### Fixed
- **Unreliability & Stalling:**
  - Implemented automatic page reload as a last-resort recovery when the solver is stuck on a question for >90s.
  - Fixed a critical bug where the internal question timer was resetting every loop iteration, preventing proper "stuck" detection.
  - Increased base detection thresholds and timeouts to accommodate slower AI response times and turbo variations.
  - Resolved potential "Cannot access variable before initialization" errors by restructuring loop variable scopes.
- **Accuracy Improvements:**
  - **Enhanced Context Awareness:** The solver now scrapes instructions, hints, and introductory text from the page to provide better context to the AI (e.g., specific rules for the nugget).
  - **Logic Strengthening:** Updated the Brain module to use Chain-of-Thought (CoT) reasoning, forcing the model to think step-by-step before providing an answer.
  - **Improved Matching:** Refined matching logic to handle complex label pairs and image-based targets more robustly.
- **Error Handling:**
  - Added fatal error detection for browser disconnections to prevent infinite recovery loops.
  - Improved button detection for assignment navigation and feedback dismissal.

## [1.2.0] - 2026-02-12

### Fixed
- **Drag & Drop Reliability:** 
  - Resolved `ElementHandle.dragTo is not a function` error by implementing a custom low-level `safeDrag` helper.
  - Added robust checks for element visibility and scrolling before interaction.
  - Implemented a verification loop that retries drag operations up to 3 times if target slots remain empty.
- **Assignment Scraping:**
  - Fixed an issue where the scraper would aggressively refresh the page in the background, causing interruption.
  - Implemented smarter "white screen" detection that only refreshes if the page is truly empty (no text/elements).
  - Added a 3-attempt retry mechanism with delays for initial assignment loading.
- **Nugget Transitions:**
  - Implemented an "Aggressive Jump" feature that transitions to the next nugget immediately when accuracy/feedback is detected.
  - Added logic to detect and dismiss "Your answer has been submitted!" overlays that block navigation.
  - Expanded button detection to handle varying text casing (e.g., "NEXT QUESTION" vs "Next Question").
- **Question Type Support:**
  - Added support for Dropdown/Select inputs (common in "Additional Answers" sections).
  - The solver can now identify standard `<select>` elements and custom `.rc-dropdown` components.

### Added
- **`safeClick` Helper:** Restored and improved the click helper to handle stubborn elements with fallback strategies (force click, evaluate click).
- **Run Script:** Restored `run.bat` for easy launching on Windows.
- **Brain Module:** Verified and restored core AI logic in `brain.js`.

### Changed
- **Performance:** Optimized the main event loop to reduce unnecessary page navigations and API calls.
- **Logging:** Enhanced console output for better debugging of matching logic and scraper errors.

### Security
- **Environment Variables:** Implemented `dotenv` for credential management. API keys and login details can now be stored in a `.env` file.
- **Git Protection:** Added a `.gitignore` file to ensure sensitive configurations and log files are not accidentally committed to GitHub.
- **Template Provided:** Added `.env.example` to guide setup for new environments.
