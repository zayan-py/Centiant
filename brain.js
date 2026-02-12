const { OpenAI } = require('openai');

class Brain {
    static async solve(question, options, apiKey, context, imageBase64, hasGuppy) {
        if (!apiKey) {
            console.log('[Brain] Missing OpenAI API Key');
            return null;
        }

        const openai = new OpenAI({ apiKey: apiKey });
        const model = 'gpt-4o';

        let prompt = `You are a helpful AI assistant solving a multiple choice question.
Context: ${context || 'General Knowledge'}
Question: ${question}
Options: ${options.join(', ')}

Please analyze the question and select the correct option.
Return your answer in the following JSON format:
{
    "type": "index" or "text",
    "value": (index of option starting at 1 OR the text answer),
    "reasoning": "Brief explanation"
}`;

        if (hasGuppy) {
            prompt += `\n\nThis question involves a mathematical input interface (Guppy). 
If the answer requires a formula or specific math notation, provide the text representation suitable for typing into a math field.`;
        }

        const messages = [
            { role: 'system', content: 'You are an expert tutor used to solve educational questions. Always output valid JSON.' },
            { role: 'user', content: prompt }
        ];

        if (imageBase64) {
            messages[1].content = [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
            ];
        }

        try {
            const completion = await openai.chat.completions.create({
                model: model,
                messages: messages,
                response_format: { type: "json_object" },
                temperature: 0.1
            });

            const content = completion.choices[0].message.content;
            console.log('[Brain] Raw Response:', content);
            return JSON.parse(content);

        } catch (error) {
            console.error('[Brain] Error:', error.message);
            return null;
        }
    }

    static async solveMatching(targets, sources, apiKey, context, imageBase64) {
        if (!apiKey) return null;

        const openai = new OpenAI({ apiKey: apiKey });
        const model = 'gpt-4o';

        let prompt = `You are solving a matching question.
Context: ${context || 'General'}
Targets (Fixed Items): ${targets.join(', ')}
Sources (Draggable Items): ${sources.join(', ')}

Pair each Target with the correct Source.
Return a JSON object where update keys are Target text and values are matching Source text.
Example: { "Capital of France": "Paris", "Capital of Spain": "Madrid" }`;

        const messages = [
            { role: 'system', content: 'You are an expert tutor. Output only valid JSON pairings.' },
            { role: 'user', content: prompt }
        ];

        if (imageBase64) {
            messages[1].content = [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
            ];
        }

        try {
            const completion = await openai.chat.completions.create({
                model: model,
                messages: messages,
                response_format: { type: "json_object" },
                temperature: 0.1
            });

            const content = completion.choices[0].message.content;
            console.log('[Brain] Matching Response:', content);
            return JSON.parse(content);

        } catch (error) {
            console.error('[Brain] Matching Error:', error.message);
            return null;
        }
    }
}

module.exports = Brain;
