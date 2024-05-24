import { Hono } from 'hono';
const app = new Hono();

app.post('/notes', async (c) => {
	const { text } = await c.req.json();
	if (!text) {
		return c.text('Missing text', 400);
	}

	const { results } = await c.env.DB.prepare('INSERT INTO notes (text) VALUES (?) RETURNING *').bind(text).run();

	const record = results.length ? results[0] : null;

	if (!record) {
		return c.text('Failed to create note', 500);
	}

	const { data } = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
	const values = data[0];

	if (!values) {
		return c.text('Failed to generate vector embedding', 500);
	}

	const { id } = record;
	const inserted = await c.env.VECTOR_INDEX.upsert([
		{
			id: id.toString(),
			values,
		},
	]);

	return c.json({ id, text, inserted });
});

app.get('/', async (c) => {
	const question = c.req.query('text') || 'What is the best pizza topping?';
	const embeddings = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: question });
	const vectors = embeddings.data[0];

	const SIMILARITY_CUTOFF = 0.75;
	const vectorQuery = await c.env.VECTOR_INDEX.query(vectors, { topK: 1 });
	const vecIds = vectorQuery.matches.filter((vec) => vec.score > SIMILARITY_CUTOFF).map((vec) => vec.id);
	vectorQuery.matches.forEach((element) => {
		console.log(element);
	});
	let notes = [];
	if (vecIds.length) {
		const query = `SELECT * FROM notes WHERE id IN (${vecIds.join(', ')})`;
		const { results } = await c.env.DB.prepare(query).bind().all();
		if (results) notes = results.map((vec) => vec.text);
	}

	const contextMessage = notes.length ? `Context:\n${notes.map((note) => `- ${note}`).join('\n')}` : '';
	console.log(contextMessage);
	const systemPrompt = `When answering the question or responding, use the context provided. If it is not provided then you should always reply with "I'm sorry, I do not have enough information to answer that question." and no other text. You should also never reference that you have been provided the context in your response.`;

	const { response: answer } = await c.env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
		messages: [
			//...(notes.length ? [{ role: 'system', content: contextMessage }] : []),
			{ role: 'system', content: contextMessage },
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: question },
		],
	});

	return c.text(answer);
});

app.onError((err, c) => {
	return c.text(err);
});

export default app;
