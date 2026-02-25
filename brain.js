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
1. Analyze the provided FULL-PAGE SCREENSHOT carefully to understand the question and all visual context.
2. Determine the correct answer.
3. For Multiple Choice Questions (MCQs), return ONLY the 1-based index of the correct option.
4. If it's a text box question, use "type": "text" and provide the most concise answer.
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

        let completion;
        let retries = 0;
        while (retries < 3) {
            try {
                completion = await openai.chat.completions.create({
                    model: model,
                    messages: messages,
                    response_format: { type: "json_object" },
                    temperature: 0,
                    max_tokens: 150
                });
                break; // Success
            } catch (error) {
                if (error.status === 429 && retries < 2) {
                    retries++;
                    console.warn(`[Brain] Rate limited. Waiting 10s before retry ${retries}/2...`);
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    console.error('[Brain] Error:', error.message);
                    return null;
                }
            }
        }
        if (!completion) return null;

        const content = completion.choices[0].message.content;
        const parsed = JSON.parse(content);
        console.log('[Brain] Answer:', parsed.value);
        return parsed;
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
1. Analyze the FULL-PAGE SCREENSHOT. If there is a diagram with arrows or letters (A, B, C, etc.), trace them carefully to determine what they point to.
2. Match each Source to the correct Target.
3. If targets are single letters (like A, B, C), find where those letters are on the diagram.
4. Return ONLY JSON:
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
