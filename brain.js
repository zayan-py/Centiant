const { OpenAI } = require('openai');

class Brain {
    static async solve(question, options, apiKey, context, imageBase64, hasGuppy, modelOverride = null) {
        if (!apiKey) {
            console.log('[Brain] Missing OpenAI API Key');
            return null;
        }

        const openai = new OpenAI({ apiKey: apiKey });
        // Default to gpt-4o for accuracy unless mini is specifically requested
        const model = modelOverride || 'gpt-4o';

        let prompt = `You are a world-class academic tutor specializing in the UK curriculum (GCSE/A-Level).
Context: ${context || 'General Knowledge'}
Question: ${question}
Options: ${options.length > 0 ? options.join(', ') : 'None (Text Input Question)'}

INSTRUCTIONS:
1. Determine the correct answer.
2. If multiple options are provided, use "type": "index" and the 1-based index.
3. If it's a text box, use "type": "text" and the most concise answer.
4. If a graph/image is provided, analyze it carefully before answering.
5. Return ONLY a JSON object:
{
    "type": "index" or "text",
    "value": (index of option starting at 1 OR the text answer)
}`;

        if (hasGuppy) {
            prompt += `\n- Math field (Guppy): Use notation like 'sqrt(x)', '^2', etc.`;
        }

        const messages = [
            { role: 'system', content: 'Expert tutor. Output JSON ONLY. No talk. No reasoning text.' },
            {
                role: 'user', content: [
                    { type: 'text', text: prompt }
                ]
            }
        ];

        if (imageBase64) {
            messages[1].content.push({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "high" }
            });
        }

        try {
            const completion = await openai.chat.completions.create({
                model: model,
                messages: messages,
                response_format: { type: "json_object" },
                temperature: 0,
                max_tokens: 150 // Keep small to save credits
            });

            const content = completion.choices[0].message.content;
            const parsed = JSON.parse(content);
            console.log('[Brain] Answer:', parsed.value);
            return parsed;

        } catch (error) {
            console.error('[Brain] Error:', error.message);
            return null;
        }
    }

    static async solveMatching(targets, sources, apiKey, context, imageBase64, modelOverride = null) {
        if (!apiKey) return null;

        const openai = new OpenAI({ apiKey: apiKey });
        const model = modelOverride || 'gpt-4o';

        let prompt = `You are a world-class academic tutor. 
Context: ${context || 'General'}
Targets (Fixed): ${targets.join(', ')}
Sources (Answers): ${sources.join(', ')}

INSTRUCTIONS:
Match each Source to the correct Target. Return ONLY JSON:
{
    "pairs": {
        "Target Text": "Source Text"
    }
}`;

        const messages = [
            { role: 'system', content: 'Expert tutor. Output JSON pairs ONLY.' },
            {
                role: 'user', content: [
                    { type: 'text', text: prompt }
                ]
            }
        ];

        if (imageBase64) {
            messages[1].content.push({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "high" }
            });
        }

        try {
            const completion = await openai.chat.completions.create({
                model: model,
                messages: messages,
                response_format: { type: "json_object" },
                temperature: 0,
                max_tokens: 800
            });

            const content = completion.choices[0].message.content;
            const parsed = JSON.parse(content);
            const pairings = parsed.pairs || parsed; // Handle cases where model might omit 'pairs' key

            // Deduplicate (LLM sometimes returns duplicate keys)
            const deduplicated = {};
            for (const [key, value] of Object.entries(pairings)) {
                if (!deduplicated[key]) {
                    deduplicated[key] = value;
                }
            }

            console.log('[Brain] Matching Complete');
            return deduplicated;

        } catch (error) {
            console.error('[Brain] Matching Error:', error.message);
            return null;
        }
    }
}

module.exports = Brain;
