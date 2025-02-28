(async () => {
    const OpenAI = require("openai");
    const fsPromises = require("fs").promises;
    const fs = require("fs");
    const assistantFilePath = "./assistant/assistant.json";
    const ASSISTANT_CONFIGURATION = require('../assistant/assistant.json');
    const { capture_lead_config } = require('../src/tools/capture-lead.ts');
    const { capture_complaint_config } = require('../src/tools/capture-complaint.ts');
    // const { fetch_data_config } = require('../src/tools/fetch-data.ts');
    // const { fetch_own_transport_config } = require('../src/tools/fetch-own-transport.ts');
    // const { fetch_cruise_config } = require('../src/tools/fetch-cruise.ts');

    require('dotenv').config();

    const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];
    const openai = new OpenAI({
        apiKey: OPENAI_API_KEY,
    });

    const assistantConfig = {
        name: "",
        instructions: "",
        model: "",
        tools: [
            { "type": "code_interpreter" },
            { "type": "file_search" },
            capture_lead_config,
            capture_complaint_config,
            // fetch_data_config,
            // fetch_cruise_config,
            // fetch_own_transport_config
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

    async function updateAssistant() {
        if (!ASSISTANT_CONFIGURATION.assistantId) {
            console.log('Missing assistantId, please provide it !');
            return;
        }

        console.log('Updating an existing assistant process initiated');

        // Prepare the new configuration

        // Read all files from the resources directory and upload them
        const files = await fsPromises.readdir('./resources');
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
            } catch (e) {
                return null
            }
        });

        const fileIds = await Promise.all(uploadPromises);
        const filteredFileIds = fileIds.filter(id => id); // take only truthty values

        // // Gather the assistant instructions
        const instructionsFilePath = './instructions/instructions.txt';
        const assistantInstructions = await fsPromises.readFile(
            instructionsFilePath,
            "utf8"
        );

        // Update the assistant config with the newly obtained data fileds
        // Put the newly provided name
        assistantConfig.name = ASSISTANT_CONFIGURATION.name;
        // Update the instructions
        assistantConfig.instructions = assistantInstructions;
        // Put the newly provided model
        assistantConfig.model = ASSISTANT_CONFIGURATION.model;
        // Update the filed ids
        assistantConfig.tool_resources.code_interpreter.file_ids = filteredFileIds;
        // The tools are provided in the basic config creation on row 15


        await openai.beta.assistants.update(ASSISTANT_CONFIGURATION.assistantId, {
            ...assistantConfig
        });

        console.log(`Assistant with id ${ASSISTANT_CONFIGURATION.assistantId} is updated sucessfully`);


        // Save the UPDATED assistant details to assistant.json
        await fsPromises.writeFile(
            assistantFilePath,
            JSON.stringify({
                assistantId: ASSISTANT_CONFIGURATION.assistantId,
                ...assistantConfig
            }, null, 2)
        );
        console.log('Assistants file updated');
    }

    updateAssistant();
})();