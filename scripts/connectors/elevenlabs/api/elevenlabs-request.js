import { ELEVENLABS_CONSTANTS } from "../constants.js";

// A client key takes precedence; use the shared key only when the client field is empty.
export function getApiKey(namespace) {
    const clientKey = game.settings.get(namespace, ELEVENLABS_CONSTANTS.APIKEY)?.trim();
    return clientKey || game.settings.get(namespace, ELEVENLABS_CONSTANTS.MASTERAPIKEY)?.trim() || "";
}

export class ElevenlabsRequest {
    api_key;
    api_url = 'https://api.elevenlabs.io/v1/';

    constructor(connector) {
        this.logger = connector.logger;
        this.api_key = getApiKey(connector.mainSettingsId);
    }

    execute() {
        throw new Error("Method 'execute()' ist not implemented in derived class.");
    };

    fetch() {
        throw new Error("Method 'fetch()' ist not implemented in derived class.");
    };

    async fetchJson(command) {
        const response =await fetch(`${this.api_url}${command}`, {
            headers: {
                'accept': 'application/json',
                'xi-api-key': this.api_key
            }
        });

        await this.checkResponseStatus(response);
    
        return await response.text();
    };

    async fetchResponse(command) {
        const response = await fetch(`${this.api_url}${command}`, {
            headers: {
                'accept': 'application/json',
                'xi-api-key': this.api_key
            }
        });

        await this.checkResponseStatus(response);
        
        return response;
    }

    async postData(command, acceptType, body) {
        let response = await fetch(`${this.api_url}${command}`, {
            method: 'POST',
            headers: {
                'accept': acceptType,
                'xi-api-key': this.api_key,
                'Content-Type': 'application/json'
            },
            body: body
        });

        await this.checkResponseStatus(response);

        return response;
    }

    async checkResponseStatus(response) {
        if (response.ok) return true;

        let detail;
        try {
            detail = (await response.json()).detail;
        } catch {
            // Proxies and network gateways may return HTML or an empty body.
        }
        const code = typeof detail?.code === "string" ? detail.code
            : typeof detail?.status === "string" ? detail.status : "";
        const message = typeof detail === "string" ? detail
            : typeof detail?.message === "string" ? detail.message : "";
        let description = `ElevenLabs request failed: HTTP ${response.status} ${response.statusText || ""}`.trim();
        if (code) description += ` (${code})`;
        if (message) description += `: ${message}`;
        // Never echo the configured credential if an upstream error includes it.
        if (this.api_key) description = description.split(this.api_key).join("[redacted]");
        const error = new Error(description.slice(0, 1000));
        error.status = response.status;
        error.code = code;
        throw error;
    }
}
