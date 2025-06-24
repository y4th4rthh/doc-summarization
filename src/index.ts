import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import path from 'path';
import { Groq } from 'groq-sdk';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth'
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
    origin: ['http://localhost:3000'], // ✅ Frontend URL
    methods: ['GET', 'POST'],
    credentials: true,
});

fastify.register(multipart);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mongo setup
const mongoClient = new MongoClient(process.env.MONGO_URI || '');
const groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });
await mongoClient.connect();
const db = mongoClient.db('neuraai');
const chatsCollection = db.collection('chats');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const runGeminiChat = async (sysPrompt: string, prompt: string) => {
    const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash-8b",
        systemInstruction: sysPrompt,
        generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 2000
        }
    });

    // Gemini only takes user input as plain string (no "messages" like OpenAI or Groq)
    const result = await model.generateContent(prompt);
    return result.response.text();
};

// Endpoint
fastify.post('/doc-chat', async function (req, reply) {
    const parts = req.parts();
    // console.log(parts);

    let text = '', model = '', user_id = '', sessionId = '', incognito = false, fileText = '', fileName = '';
    let file: any;

    try {
        let fieldsParsed = new Set();

        for await (const part of parts) {
            try {
                if (part.type === 'file') {
                    file = part;
                    fieldsParsed.add('file');
                } else {
                    const value = part.value?.toString() ?? '';
                    switch (part.fieldname) {
                        case 'text': text = value; fieldsParsed.add('text'); break;
                        case 'model': model = value; fieldsParsed.add('model'); break;
                        case 'user_id': user_id = value; fieldsParsed.add('user_id'); break;
                        case 'fileName': fileName = value; fieldsParsed.add('fileName'); break;
                        case 'sessionId': sessionId = value ?? ''; fieldsParsed.add('sessionId'); break;
                        case 'incognito': incognito = value === 'true'; fieldsParsed.add('incognito'); break;
                    }
                }

                console.log("file text", fileName);
                console.log("text", sessionId);

                if (
                    fieldsParsed.has('text') &&
                    fieldsParsed.has('model') &&
                    fieldsParsed.has('user_id') &&
                    fieldsParsed.has('fileName') &&
                    fieldsParsed.has('file') &&
                    fieldsParsed.has('incognito')
                ) {
                    console.log("✅ All required fields received, breaking loop");
                    break;
                }

            } catch (innerErr) {
                console.error("❌ Error during part parsing:", innerErr);
            }
        }

        console.log("FINISHED LOOOPPP")
    } catch (err) {
        console.error("Failed to parse multipart:", err);
    }

    console.log("HERE");
    if (file) {
        const tempPath = path.join(__dirname, 'temp', file.filename);
        await fs.ensureDir(path.dirname(tempPath));
        await fs.writeFile(tempPath, await file.toBuffer());

        if (file.filename.endsWith('.pdf')) {
            fileText = "SORRY PDFs ARE CURRENTLY UNSUPPORTED FORMAT";
        }
        else if (file.filename.endsWith('.png') || file.filename.endsWith('.jpg') || file.filename.endsWith('.jpeg')) {
            const tesseract = await import('tesseract.js');
            const { data: { text } } = await tesseract.default.recognize(tempPath, 'eng');
            fileText = text.trim(); // clean up result

        }
        else if (file.filename.endsWith('.csv')) {
            const csvContent = await fs.readFile(tempPath, 'utf-8');
            const records = parse(csvContent, {
                columns: false,
                skip_empty_lines: true,
            });
            fileText = records.map((row: string[]) => row.join(', ')).join('\n');
        }
        else if (file.filename.endsWith('.xlsx') || file.filename.endsWith('.xls')) {
            const buffer = await fs.readFile(tempPath);
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }); // raw rows
            fileText = (jsonData as any[][]).map((row) => row.join(', ')).join('\n');
        }
        else if (file.filename.endsWith('.docx')) {
            const buffer = await fs.readFile(tempPath);
            const mammoth = await import('mammoth');
            const result = await mammoth.default.extractRawText({ buffer });
            fileText = result.value;
        }
        else {
            fileText = await fs.readFile(tempPath, 'utf-8');
        }

        await fs.unlink(tempPath);
    }

    if (!file && sessionId) {
        const chatData = await chatsCollection.findOne({ "session_id": sessionId })
        fileText = chatData?.ai_response;
        console.log("File Text", fileText);
    }


    console.log(fileText);

    const prompt = fileText
        ? `The user uploaded the following document:\n\n${fileText}\n\nUser query: ${text}`
        : text;

    const usrText = fileName
        ? `User query: ${text}`
        : text;

    const sysPrompt = `You are an assistant who answers based on uploaded documents.`;

    // const chatCompletion = await groqClient.chat.completions.create({
    //     messages: [
    //         { role: "system", content: sysPrompt },
    //         { role: "user", content: prompt }
    //     ],
    //     model: "llama3-70b-8192",
    //     max_tokens: 2000,
    //     temperature: 0.9
    // });

    // const aiResponse = chatCompletion.choices[0]?.message?.content || "No response";
    const aiResponse = await runGeminiChat(sysPrompt, prompt);

    // const aiResponse = "Technical Tools: Microsoft Excel,Word, PowerPoint \n Other Skills: Problem Solving,Active Listening, Process Improvement, Documentation,Change management";
    console.log("AI RES", aiResponse);


    if (!incognito) {
        await chatsCollection.insertOne({
            session_id: sessionId || `${Date.now()}`,
            timestamp: new Date(),
            user_text: usrText,
            user_id,
            file_name: fileName,
            model,
            ai_response: aiResponse
        });
    }

    return reply.send({
        userText: usrText,
        aiText: aiResponse,
        fileName: fileName,
        session_id: sessionId || `${Date.now()}`
    });
});

const PORT = Number(process.env.PORT) || 8000;

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) throw err;
    fastify.log.info(`🚀 Server running at ${address}`);
});
