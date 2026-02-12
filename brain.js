/**
 * Century Solver Pro - AI Brain Module
 * Contains knowledge base and pattern matching for automated solving.
 */

const OpenAI = require('openai');

/**
 * Determines the correct answer based on question text and provided options.
 * @param {string} questionText 
 * @param {string[]} options 
 * @param {string} apiKey
 * @param {string} context
 * @returns {Promise<object|null>} { type: 'index'|'text', value: any }
 */
/**
 * Solves a multiple choice or text question using LLM + Vision.
 * @param {string} questionText The question text
 * @param {string[]} options Array of option texts (if MCQ)
 * @param {string} apiKey OpenAI API Key
 * @param {string} context Lesson context (e.g. "Biology - Cells")
 * @param {string} imageBase64 Optional: Base64 string of the question screenshot
 * @param {boolean} numericOnly Optional: If true, instructs LLM to return only numeric values (for Guppy Math)
 * @returns {Promise<object|null>} { type: 'index'|'text', value: number|string }
 */
async function solve(questionText, options = [], apiKey = null, context = '', imageBase64 = null, numericOnly = false) {
    if (!apiKey) return null;

    try {
        const openai = new OpenAI({ apiKey: apiKey });

        // Enhanced prompt for better accuracy
        let instructions = `You are an expert tutor answering a Century Tech question.

TOPIC: "${context || 'General Knowledge'}"
QUESTION: "${questionText}"
`.trim();

        if (options.length > 0) {
            instructions += `

OPTIONS:
${options.map((o, i) => `${i + 1}: ${o}`).join('\n')}

INSTRUCTIONS:
1. Read the question carefully.
2. Consider EACH option before deciding.
3. If it requires calculation, work through it step-by-step in your head.
4. Return ONLY the number of the correct option (e.g., "2").
5. Do NOT include any explanation or text.`;
        } else if (numericOnly) {
            // Guppy Math mode - numeric only
            instructions += `

CRITICAL INSTRUCTIONS FOR NUMERIC ANSWER:
1. Return ONLY a number. NO units, NO text, NO symbols.
2. If the answer is "36.75 Newtons", return ONLY: 36.75
3. If the answer is "5 kg", return ONLY: 5
4. If the answer is "2.5 m/s", return ONLY: 2.5
5. Do NOT include units like N, kg, m, s, J, W, etc.
6. Be precise with decimal places.`;
        } else {
            // Standard text answer
            instructions += `

INSTRUCTIONS:
1. Provide ONLY the answer, no explanation.
2. Be precise and concise.
3. Do NOT use quotation marks in your response.`;
        }

        const messages = [];

        if (imageBase64) {
            console.log('[Brain] Multimodal Vision Request' + (numericOnly ? ' (Numeric Only)' : ''));
            messages.push({
                role: "user",
                content: [
                    { type: "text", text: instructions },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
                ]
            });
        } else {
            console.log('[Brain] Text-only Request' + (numericOnly ? ' (Numeric Only)' : ''));
            messages.push({ role: "user", content: instructions });
        }

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages,
            max_tokens: numericOnly ? 20 : (options.length > 0 ? 10 : 100),
            temperature: 0, // Deterministic for accuracy
        });

        let result = completion.choices[0].message.content.trim();
        console.log(`[Brain] LLM Response: "${result}"`);

        if (options.length > 0) {
            // MCQ: Extract index
            const index = parseInt(result.replace(/\D/g, ''));
            if (!isNaN(index) && index >= 1 && index <= options.length) {
                return { type: 'index', value: index };
            } else {
                console.log(`[Brain] Invalid index returned: ${index}`);
                return { type: 'index', value: 1 }; // Fallback
            }
        } else if (numericOnly) {
            // Guppy Math: Clean to pure number
            // Remove any non-numeric chars except decimal point and minus
            const cleaned = result.replace(/[^0-9.\-]/g, '');
            console.log(`[Brain] Cleaned numeric value: "${cleaned}"`);
            return { type: 'text', value: cleaned || result };
        } else {
            return { type: 'text', value: result };
        }
    } catch (e) {
        console.error('[Brain] LLM Error:', e.message);
        return null;
    }
}

// ... existing solve function ...

/**
 * Solves matching/drag-and-drop questions.
 * @param {string[]} targets The fixed items (e.g. "Reactivity")
 * @param {string[]} sources The draggable definitions
 * @param {string} apiKey
 * @param {string} context
 * @param {string} imageBase64 Optional: Base64 string of the question screenshot
 * @returns {Promise<object|null>} { "Target Text": "Source Text" }
 */
async function solveMatching(targets, sources, apiKey = null, context = '', imageBase64 = null) {
    if (!apiKey) return null;

    try {
        const openai = new OpenAI({ apiKey: apiKey });
        const prompt = `
            You are solving a matching question.
            CONTEXT: "${context}"
            
            ITEMS (Targets):
            ${targets.map(t => `- ${t}`).join('\n')}
            
            DEFINITIONS (Draggables):
            ${sources.map(s => `- ${s}`).join('\n')}
            
            INSTRUCTIONS:
            - Pair each ITEM with its correct DEFINITION.
            - Return ONLY a valid JSON object where keys are Items and values are Definitions.
            - Example: { "Reactivity": "How likely..." }
        `.trim();

        const messages = [];

        if (imageBase64) {
            console.log('[Brain] Multimodal Vision Request (Matching)');
            messages.push({
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
                ]
            });
        } else {
            console.log('[Brain] Text-only Request (Matching)');
            messages.push({ role: "user", content: prompt });
        }

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages,
            response_format: { type: "json_object" },
            max_tokens: 300,
        });

        const result = JSON.parse(completion.choices[0].message.content);
        console.log(`[Brain] Matching Response: ${JSON.stringify(result)}`);
        return result; // Expected: { "Target1": "Source1", ... }
    } catch (e) {
        console.error('[Brain] Matching Error:', e.message);
        return null;
    }
}

module.exports = { solve, solveMatching };
