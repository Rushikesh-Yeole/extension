const vscode = require('vscode');
const fetch = require('node-fetch');

function activate(context) {
    console.log('DevGear AI extension activating...');
    
    const provider = new ChatViewProvider(context.extensionUri);
    
    const disposable = vscode.window.registerWebviewViewProvider(
        'devgear.chatView',
        provider,
        { webviewOptions: { retainContextWhenHidden: true } }
    );
    
    context.subscriptions.push(disposable);
    
    // Register command to set API key
    context.subscriptions.push(
        vscode.commands.registerCommand('devgear.setApiKey', async () => {
            const apiKey = await vscode.window.showInputBox({
                prompt: 'Enter your Gemini API Key',
                password: true,
                placeHolder: 'AIza...'
            });
            if (apiKey) {
                await vscode.workspace.getConfiguration('devgear').update('geminiApiKey', apiKey, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('Gemini API key updated successfully!');
            }
        })
    );
    
    console.log('DevGear AI provider registered successfully');
    console.log('Waiting for view to be shown...');
}

class ChatViewProvider {
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
        this._view = null;
    }

    resolveWebviewView(webviewView, context, token) {
        console.log('Resolving webview view...');
        
        this._view = webviewView;
        try {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [this.extensionUri]
            };
            webviewView.webview.html = this.getHtmlContent();
            webviewView.webview.onDidReceiveMessage(async (data) => {
                console.log('Received message:', data.type);
                
                switch (data.type) {
                    case 'chat':
                        await this.handleChat(data.text);
                        break;
                    case 'clear':
                        this._view.webview.postMessage({ type: 'clearChat' });
                        break;
                }
            });
            console.log('Webview view resolved successfully');
        } catch (error) {
            console.error('Error resolving webview view:', error);
            vscode.window.showErrorMessage('Failed to initialize DevGear AI view: ' + error.message);
        }
    }

    async getAvailableModels(apiKey) {
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch models: ${response.status}`);
            }
            const data = await response.json();
            return data.models.map(model => model.name);
        } catch (error) {
            console.error('Error fetching models:', error);
            return [];
        }
    }

    async getWorkspaceContext() {
        const files = await vscode.workspace.findFiles('**/*.{js,ts,py,java,cpp,md}', '**/node_modules/**', 10);
        let context = '';
        for (const file of files) {
            try {
                const doc = await vscode.workspace.openTextDocument(file);
                const text = doc.getText();
                context += `\n--- FILE: ${vscode.workspace.asRelativePath(file)} ---\n${text}\n`;
            } catch (e) {
                console.error(`Failed reading ${file.fsPath}`, e);
            }
        }
        return context;
    }

    async handleChat(userMessage) {
        if (!this._view) {
            console.error('Webview not initialized');
            return;
        }
        
        try {
            this._view.webview.postMessage({ type: 'loading', loading: true });
            const config = vscode.workspace.getConfiguration('devgear');
            let apiKey = config.get('geminiApiKey');
            
            if (!apiKey) {
                apiKey = await vscode.window.showInputBox({
                    prompt: 'Enter your Gemini API Key (or use command: DevGear AI: Set Gemini API Key)',
                    password: true,
                    placeHolder: 'AIza...'
                });
                
                if (!apiKey) {
                    this._view.webview.postMessage({ 
                        type: 'error', 
                        message: 'API key is required. Set it in Settings or use the command "DevGear AI: Set Gemini API Key".' 
                    });
                    return;
                }
                
                await config.update('geminiApiKey', apiKey, vscode.ConfigurationTarget.Global);
            }

            let model = 'gemini-1.5-flash';
            const codeContext = await this.getWorkspaceContext();
            const fullPrompt = `You are DevGear AI. The user is asking about the codebase.
Here is relevant code context:\n${codeContext}\n
User question: ${userMessage}`;

            try {
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: fullPrompt }] }]
                    })
                });

                if (!response.ok) {
                    if (response.status === 404) {
                        const models = await this.getAvailableModels(apiKey);
                        if (models.length > 0) {
                            model = models.find(m => m.includes('gemini-1.5')) || models[0];
                            const retryResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    contents: [{ parts: [{ text: fullPrompt }] }]
                                })
                            });
                            if (!retryResponse.ok) {
                                throw new Error(`API Error: ${retryResponse.status} - ${await retryResponse.text()}`);
                            }
                            const retryData = await retryResponse.json();
                            if (retryData.error) {
                                throw new Error(retryData.error.message);
                            }
                            const aiResponse = retryData.candidates?.[0]?.content?.parts?.[0]?.text || 'No response received';
                            this._view.webview.postMessage({ 
                                type: 'response', 
                                message: aiResponse 
                            });
                            return;
                        } else {
                            throw new Error('No available models found. Please check your API key or region.');
                        }
                    }
                    throw new Error(`API Error: ${response.status} - ${await response.text()}`);
                }

                const data = await response.json();
                
                if (data.error) {
                    throw new Error(data.error.message);
                }
                
                const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response received';
                
                this._view.webview.postMessage({ 
                    type: 'response', 
                    message: aiResponse 
                });
            } catch (error) {
                throw new Error(`Failed with model ${model}: ${error.message}`);
            }
        } catch (error) {
            console.error('Chat error:', error);
            this._view.webview.postMessage({ 
                type: 'error', 
                message: `Error: ${error.message}` 
            });
        } finally {
            this._view.webview.postMessage({ type: 'loading', loading: false });
        }
    }

    getHtmlContent() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' vscode-resource:; img-src vscode-resource:; connect-src https://generativelanguage.googleapis.com;">
    <title>DevGear AI</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
        
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        
        :root {
            --primary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            --success-gradient: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
            --glass-bg: rgba(255, 255, 255, 0.05);
            --glass-border: rgba(255, 255, 255, 0.1);
            --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.1);
            --shadow-md: 0 8px 32px rgba(0, 0, 0, 0.15);
            --animation-speed: 0.3s;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--vscode-sideBar-background);
            color: var(--vscode-sideBar-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
        }
        
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: 
                radial-gradient(circle at 20% 20%, rgba(120, 119, 198, 0.1) 0%, transparent 50%),
                radial-gradient(circle at 80% 80%, rgba(255, 119, 198, 0.1) 0%, transparent 50%),
                radial-gradient(circle at 40% 40%, rgba(120, 199, 198, 0.1) 0%, transparent 50%);
            pointer-events: none;
            z-index: 0;
        }
        
        .header {
            padding: 16px 20px;
            position: relative;
            z-index: 10;
        }
        
        .header-content {
			justify-content: center,
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .logo {
            display: flex;
            align-items: center;
            gap: 12px;
            font-weight: 600;
            font-size: 16px;
        }
        
        .logo-icon {
            width: 28px;
            height: 28px;
            background: var(--primary-gradient);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 14px;
            font-weight: bold;
            box-shadow: var(--shadow-sm);
        }
        
        .header-actions {
            display: flex;
            gap: 8px;
        }
        
        .icon-btn {
            width: 32px;
            height: 32px;
            border: none;
            border-radius: 8px;
            background: transparent;
            color: var(--vscode-sideBar-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all var(--animation-speed) ease;
            font-size: 14px;
        }
        
        .icon-btn:hover {
            background: var(--glass-bg);
            backdrop-filter: blur(10px);
            transform: translateY(-1px);
        }
        
        .chat-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
            position: relative;
            z-index: 5;
        }
        
        .messages {
            flex: 1;
            padding: 20px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 20px;
            scroll-behavior: smooth;
        }
        
        .messages::-webkit-scrollbar {
            width: 6px;
        }
        
        .messages::-webkit-scrollbar-track {
            background: transparent;
        }
        
        .messages::-webkit-scrollbar-thumb {
            background: var(--glass-border);
            border-radius: 3px;
        }
        
        .message {
            display: flex;
            flex-direction: column;
            gap: 8px;
            animation: messageSlide 0.4s ease-out;
        }
        
        @keyframes messageSlide {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .message.user {
            align-items: flex-end;
        }
        
        .message-header {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            font-weight: 500;
        }
        
        .message-avatar {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            font-weight: 600;
        }
        
        .user .message-avatar {
            background: var(--primary-gradient);
            color: white;
        }
        
        .ai .message-avatar {
            background: var(--success-gradient);
            color: white;
        }
        
        .message-bubble {
            max-width: 85%;
            padding: 16px 20px;
            border-radius: 16px;
            font-size: 14px;
            line-height: 1.6;
            word-wrap: break-word;
            position: relative;
            backdrop-filter: blur(20px);
            border: 1px solid var(--glass-border);
            box-shadow: var(--shadow-sm);
            transition: all var(--animation-speed) ease;
        }
        
        .message-bubble:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-md);
        }
        
        .user .message-bubble {
            background: var(--primary-gradient);
            color: white;
            border: none;
        }
        
        .ai .message-bubble {
            background: var(--glass-bg);
            color: var(--vscode-sideBar-foreground);
        }
        
        .input-area {
            padding: 20px;
            position: relative;
            z-index: 10;
        }
        
        .input-container {
			justify-content: center,
            display: flex;
            gap: 12px;
            align-items: flex-end;
            position: relative;
        }
        
        .input-wrapper {
            flex: 1;
            position: relative;
        }
        
        #messageInput {
            flex: 1;
            width: 100%;
            min-height: 44px;
            max-height: 120px;
            padding: 12px 50px 12px 20px;
            border: 1px solid var(--glass-border);
            border-radius: 22px;
            background: var(--glass-bg);
            backdrop-filter: blur(20px);
            color: var(--vscode-input-foreground);
            font-size: 14px;
            resize: none;
            outline: none;
            font-family: inherit;
            transition: all var(--animation-speed) ease;
            box-shadow: var(--shadow-sm);
        }
        
        #messageInput:focus {
            border-color: var(--vscode-focusBorder);
            box-shadow: var(--shadow-md);
            transform: translateY(-1px);
        }
        
        #messageInput::placeholder {
            color: var(--vscode-input-placeholderForeground);
            opacity: 0.7;
        }
        
        .input-actions {
            position: absolute;
            right: 8px;
            bottom: 8px;
            display: flex;
            gap: 4px;
        }
        
        #sendBtn {
            width: 28px;
            height: 28px;
            border: none;
            border-radius: 70%;
            background: var(--primary-gradient);
            color: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            transition: all var(--animation-speed) ease;
            box-shadow: var(--shadow-sm);
        }
        
        #sendBtn:hover:not(:disabled) {
            transform: scale(1.1);
            box-shadow: var(--shadow-md);
        }
        
        #sendBtn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        
        .loading-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 13px;
            padding: 16px 20px;
        }
        
        .loading-dots {
            display: flex;
            gap: 4px;
        }
        
        .loading-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--success-gradient);
            animation: loadingPulse 1.4s infinite ease-in-out;
        }
        
        .loading-dot:nth-child(2) {
            animation-delay: 0.2s;
        }
        
        .loading-dot:nth-child(3) {
            animation-delay: 0.4s;
        }
        
        @keyframes loadingPulse {
            0%, 80%, 100% {
                transform: scale(0.8);
                opacity: 0.5;
            }
            40% {
                transform: scale(1);
                opacity: 1;
            }
        }
        
        pre {
            background: rgba(0, 0, 0, 0.2);
            padding: 16px;
            border-radius: 12px;
            overflow-x: auto;
            font-size: 13px;
            margin: 12px 0;
            border: 1px solid var(--glass-border);
            backdrop-filter: blur(10px);
            position: relative;
        }
        
        pre::before {
            content: 'Code';
            position: absolute;
            top: 8px;
            right: 12px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            font-weight: 500;
        }
        
        code {
            background: rgba(0, 0, 0, 0.2);
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 13px;
            border: 1px solid var(--glass-border);
        }
        
        .welcome {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
            font-size: 14px;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
        }
        
        .welcome-icon {
            width: 64px;
            height: 64px;
            background: var(--primary-gradient);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 28px;
            box-shadow: var(--shadow-md);
            animation: welcomePulse 2s infinite ease-in-out;
        }
        
        @keyframes welcomePulse {
            0%, 100% {
                transform: scale(1);
            }
            50% {
                transform: scale(1.05);
            }
        }
        
        .welcome h2 {
            font-size: 18px;
            font-weight: 600;
            color: var(--vscode-sideBar-foreground);
            margin: 0;
        }
        
        .welcome p {
            margin: 8px 0;
            opacity: 0.8;
        }
        
        .suggestions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            justify-content: center;
            margin-top: 20px;
        }
        
        .suggestion-chip {
            background: var(--glass-bg);
            border: 1px solid var(--glass-border);
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 12px;
            cursor: pointer;
            transition: all var(--animation-speed) ease;
            backdrop-filter: blur(10px);
        }
        
        .suggestion-chip:hover {
            background: var(--primary-gradient);
            color: white;
            transform: translateY(-2px);
            box-shadow: var(--shadow-sm);
        }
        
        .error-message {
            color: var(--vscode-errorForeground);
            background: rgba(255, 0, 0, 0.1);
            border: 1px solid rgba(255, 0, 0, 0.2);
            padding: 12px 16px;
            border-radius: 12px;
            font-size: 13px;
            margin: 8px 0;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .typing-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 16px 20px;
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
            font-style: italic;
        }
        
        @media (max-width: 400px) {
            .message-bubble {
                max-width: 95%;
                padding: 12px 16px;
            }
            
            .header {
                padding: 12px 16px;
            }
            
            .messages {
                padding: 16px;
                gap: 16px;
            }
            
            .input-area {
                padding: 16px;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-conten">
            <div class="logo">
                <div class="logo-icon">⚡</div>
                <span>DevGear AI</span>
            </div>
        </div>
    </div>
    
    <div class="chat-container">
        <div class="messages" id="messages">
            <div class="welcome">
                <div class="welcome-icon">🤖</div>
                <h2>Welcome to DevGear AI</h2>
                <p>Your intelligent coding companion powered by advanced AI</p>
                <p>Ask me anything about your code, get explanations, or request optimizations!</p>
                <div class="suggestions">
                    <div class="suggestion-chip" data-text="Explain this function">Explain code</div>
                    <div class="suggestion-chip" data-text="Find bugs in my code">Find bugs</div>
                    <div class="suggestion-chip" data-text="Optimize this code">Optimize</div>
                    <div class="suggestion-chip" data-text="Write unit tests">Write tests</div>
                </div>
            </div>
        </div>
        
        <div class="input-area">
            <div class="input-container">
                <div class="input-wrapper">
                    <textarea id="messageInput" placeholder="Ask DevGear AI anything about your code..." rows="1"></textarea>
                    <div class="input-actions">
                        <button id="sendBtn" title="Send message">▶</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        (function() {
            console.log('DevGear AI webview loaded');
            
            try {
                const vscode = acquireVsCodeApi();
                const messages = document.getElementById('messages');
                const input = document.getElementById('messageInput');
                const sendBtn = document.getElementById('sendBtn');
                
                let isLoading = false;
                let messageCount = 0;
                
                // Auto-resize textarea with smooth animation
                input.addEventListener('input', function() {
                    this.style.height = 'auto';
                    const newHeight = Math.min(this.scrollHeight, 120);
                    this.style.height = newHeight + 'px';
                });
                
                
                
                // Suggestion chips
                document.addEventListener('click', (e) => {
                    if (e.target.classList.contains('suggestion-chip')) {
                        const text = e.target.getAttribute('data-text');
                        input.value = text;
                        input.focus();
                        // Trigger input event for auto-resize
                        input.dispatchEvent(new Event('input'));
                    }
                });
                
                function createWelcomeMessage() {
                    return document.querySelector('.welcome').cloneNode(true);
                }
                
                function send() {
                    const text = input.value.trim();
                    if (!text || isLoading) return;
                    
                    console.log('Sending message:', text);
                    
                    // Clear welcome message on first send
                    const welcome = messages.querySelector('.welcome');
                    if (welcome) {
                        welcome.style.animation = 'messageSlide 0.3s ease-out reverse';
                        setTimeout(() => welcome.remove(), 300);
                    }
                    
                    addMessage(text, 'user');
                    input.value = '';
                    input.style.height = 'auto';
                    
                    vscode.postMessage({ type: 'chat', text: text });
                }
                
                sendBtn.addEventListener('click', send);
                
                input.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        send();
                    }
                });
                
                function addMessage(content, sender) {
                    messageCount++;
                    
                    const messageDiv = document.createElement('div');
                    messageDiv.className = 'message ' + sender;
                    messageDiv.style.opacity = '0';
                    
                    const headerDiv = document.createElement('div');
                    headerDiv.className = 'message-header';
                    
                    const avatar = document.createElement('div');
                    avatar.className = 'message-avatar';
                    avatar.textContent = sender === 'user' ? 'U' : 'AI';
                    
                    const label = document.createElement('span');
                    label.textContent = sender === 'user' ? 'You' : 'DevGear AI';
                    
                    headerDiv.appendChild(avatar);
                    headerDiv.appendChild(label);
                    
                    const bubble = document.createElement('div');
                    bubble.className = 'message-bubble';
                    
                    if (sender === 'ai') {
                        bubble.innerHTML = formatAIResponse(content);
                    } else {
                        bubble.textContent = content;
                    }
                    
                    messageDiv.appendChild(headerDiv);
                    messageDiv.appendChild(bubble);
                    messages.appendChild(messageDiv);
                    
                    // Animate in
                    setTimeout(() => {
                        messageDiv.style.opacity = '1';
                    }, 50);
                    
                    messages.scrollTop = messages.scrollHeight;
                }
                
                function formatAIResponse(content) {
                    return content
							.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>')
                            .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                            .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
                            .replace(/\\n/g, '<br>');
                }
                
                function showTypingIndicator() {
                    const typingDiv = document.createElement('div');
                    typingDiv.className = 'message ai';
                    typingDiv.id = 'typing-indicator';
                    
                    const headerDiv = document.createElement('div');
                    headerDiv.className = 'message-header';
                    
                    const avatar = document.createElement('div');
                    avatar.className = 'message-avatar';
                    avatar.textContent = 'AI';
                    
                    const label = document.createElement('span');
                    label.textContent = 'DevGear AI is typing...';
                    
                    headerDiv.appendChild(avatar);
                    headerDiv.appendChild(label);
                    
                    const bubble = document.createElement('div');
                    bubble.className = 'message-bubble';
                    
                    const loadingHTML = '<div class="loading-indicator">' +
                        '<span>Thinking</span>' +
                        '<div class="loading-dots">' +
                        '<div class="loading-dot"></div>' +
                        '<div class="loading-dot"></div>' +
                        '<div class="loading-dot"></div>' +
                        '</div>' +
                        '</div>';
                    
                    bubble.innerHTML = loadingHTML;
                    
                    typingDiv.appendChild(headerDiv);
                    typingDiv.appendChild(bubble);
                    messages.appendChild(typingDiv);
                    messages.scrollTop = messages.scrollHeight;
                }
                
                function removeTypingIndicator() {
                    const indicator = document.getElementById('typing-indicator');
                    if (indicator) {
                        indicator.style.animation = 'messageSlide 0.3s ease-out reverse';
                        setTimeout(() => indicator.remove(), 300);
                    }
                }
                
                // Handle messages from extension
                window.addEventListener('message', function(event) {
                    const message = event.data;
                    console.log('Received message from extension:', message.type);
                    
                    switch (message.type) {
                        case 'response':
                            removeTypingIndicator();
                            addMessage(message.message, 'ai');
                            break;
                            
                        case 'loading':
                            isLoading = message.loading;
                            sendBtn.disabled = message.loading;
                            
                            if (message.loading) {
                                showTypingIndicator();
                            } else {
                                removeTypingIndicator();
                            }
                            break;
                            
                        case 'error':
                            removeTypingIndicator();
                            const errorDiv = document.createElement('div');
                            errorDiv.className = 'message ai';
                            
                            const errorHTML = '<div class="message-header">' +
                                '<div class="message-avatar">AI</div>' +
                                '<span>DevGear AI</span>' +
                                '</div>' +
                                '<div class="message-bubble">' +
                                '<div class="error-message">' +
                                '<span>⚠️</span>' +
                                '<span>' + message.message + '</span>' +
                                '</div>' +
                                '</div>';
                            
                            errorDiv.innerHTML = errorHTML;
                            messages.appendChild(errorDiv);
                            messages.scrollTop = messages.scrollHeight;
                            break;
                            
                        case 'clearChat':
                            const welcome = createWelcomeMessage();
                            messages.innerHTML = '';
                            messages.appendChild(welcome);
                            messageCount = 0;
                            break;
                    }
                });
                
                // Focus input on load
                setTimeout(() => {
                    input.focus();
                }, 500);
                
                // Add subtle hover effects to messages
                messages.addEventListener('mouseover', (e) => {
                    const bubble = e.target.closest('.message-bubble');
                    if (bubble) {
                        bubble.style.transform = 'translateY(-2px)';
                        bubble.style.boxShadow = 'var(--shadow-md)';
                    }
                });
                
                messages.addEventListener('mouseout', (e) => {
                    const bubble = e.target.closest('.message-bubble');
                    if (bubble) {
                        bubble.style.transform = 'translateY(0)';
                        bubble.style.boxShadow = 'var(--shadow-sm)';
                    }
                });
                
                // Add keyboard shortcuts
                document.addEventListener('keydown', (e) => {
                    // Ctrl/Cmd + K to focus input
                    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                        e.preventDefault();
                        input.focus();
                    }
                    
                    
                });
                
                // Add smooth scrolling when new messages arrive
                const observer = new MutationObserver(() => {
                    messages.scrollTo({
                        top: messages.scrollHeight,
                        behavior: 'smooth'
                    });
                });
                
                observer.observe(messages, {
                    childList: true,
                    subtree: true
                });
                
                console.log('DevGear AI ready - Press Ctrl+K to focus input, Ctrl+L to clear chat');
                
            } catch (error) {
                console.error('Webview script error:', error);
                
                const errorHTML = '<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; padding: 20px; text-align: center;">' +
                    '<div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>' +
                    '<h2 style="color: var(--vscode-errorForeground); margin-bottom: 8px;">Failed to initialize DevGear AI</h2>' +
                    '<p style="color: var(--vscode-descriptionForeground); font-size: 14px;">' + error.message + '</p>' +
                    '</div>';
                
                document.body.innerHTML = errorHTML;
            }
        })();
    </script>
</body>
</html>`;
    }
}

function deactivate() {
    console.log('DevGear AI extension deactivated');
}

module.exports = { activate, deactivate };