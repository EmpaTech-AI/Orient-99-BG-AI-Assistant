(async () => {
    const OpenAI = require("openai");
    const fsPromises = require("fs").promises;
    const fs = require("fs");
    const assistantFilePath = "./assistant/assistant.json";
    const { capture_lead_config } = require('../src/tools/capture-lead.ts');
    const { capture_complaint_config } = require('../src/tools/capture-complaint.ts');
    // const { fetch_data_config } = require('../src/tools/fetch-data.ts');
    // const { fetch_cruise_config } = require('../src/tools/fetch-cruise.ts');
    // const { fetch_own_transport_config } = require('../src/tools/fetch-own-transport.ts');
    
    require('dotenv').config();

    const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];

    const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    });

    const assistantConfig = {
        name: "EkvatorBG AI Assistant",
        instructions: "",
        model: "gpt-4o",
        tools: [
            { "type": "code_interpreter" },
            { "type": "file_search" },
            capture_lead_config,
            capture_complaint_config,
            // fetch_data_config,
            // fetch_own_transport_config,
            // fetch_cruise_config,
        ],
        tool_resources: {
            "file_search": {
                "vector_store_ids": []
            },
            "code_interpreter": {
                "file_ids": []
            }
        }
    };

    async function createNewAssistant() {
        console.log('Creating a new assistant process initiated');

        // Read all files from the resources directory and upload them
        const files =  await fsPromises.readdir('./resources');
        const filteredFiles = files.filter(name => name !== '.DS_Store');

        const uploadPromises = filteredFiles.map(async (fileName) => {
            const filePath = `./resources/${fileName}`;
            // Upload the file
            try {
                const file = await openai.files.create({
                    file: fs.createReadStream(filePath),
                    purpose: "assistants",
                });
                return file.id;
            } catch(e) {
                return null
            }
        });

        const fileIds = await Promise.all(uploadPromises);
        const filteredFileIds = fileIds.filter(id => id); // take only truthty values

        // Gather the assistant instructions
        const instructionsFilePath =  './instructions/instructions.txt';
        const assistantInstructions = await fsPromises.readFile(
            instructionsFilePath,
            "utf8"
        );

        // Update the assistant config with the newly obtained data fileds
        assistantConfig.tool_resources.code_interpreter.file_ids = filteredFileIds;
        assistantConfig.instructions = assistantInstructions;

        // // @ts-ignore
        const assistant = await openai.beta.assistants.create(assistantConfig);
        const assistantDetails = { assistantId: assistant.id, ...assistantConfig };
        console.log('new assistant created');

        // Save the assistant details to assistant.json
        await fsPromises.writeFile(
        assistantFilePath,
        JSON.stringify(assistantDetails, null, 2)
        );
        console.log('assistants file created');
    }

    createNewAssistant();
})();