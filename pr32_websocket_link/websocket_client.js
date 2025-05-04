const WebSocket = require('ws');
const readline = require('readline');

const SERVER_URL = 'ws://localhost:1234';
console.log(`🔌 Connectant al servidor WebSocket a ${SERVER_URL}...`);
const ws = new WebSocket(SERVER_URL);
let currentPosition = { x: 0, y: 0 };

function displayPosition() {
    process.stdout.write('\r' + ' '.repeat(process.stdout.columns) + '\r');
    process.stdout.write(`📍 Posició actual: (${currentPosition.x}, ${currentPosition.y}) | Mou-te amb les fletxes | Sortir: 'q' `);
}

ws.on('open', () => {
    console.log('✅ Connexió establerta amb el servidor WebSocket.');
    console.log('🎮 Controls actius: Utilitza les tecles de fletxa per moure\'t. Premeu "q" per sortir.');
    
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }

    process.stdin.on('keypress', (str, key) => {
        if (key.name === 'q') {
            console.log("\n👋 Has sortit del joc.");
            ws.close();
            return;
        }

        let command = null;
        switch (key.name) {
            case 'up': command = 'up'; break;
            case 'down': command = 'down'; break;
            case 'left': command = 'left'; break;
            case 'right': command = 'right'; break;
        }

        if (command) {
            try {
                console.log(`🚀 Comanda enviada: ${command}`);
                ws.send(JSON.stringify({ command }));
            } catch (error) {
                console.error('⚠️ Error en enviar la comanda:', error);
            }
        } else {
            displayPosition();
        }
    });
});

ws.on('message', (message) => {
    try {
        const data = JSON.parse(message.toString());
        process.stdout.write('\r' + ' '.repeat(process.stdout.columns) + '\r');

        switch (data.type) {
            case 'initialState':
                console.log('📦 Estat inicial rebut.');
                currentPosition.x = data.x;
                currentPosition.y = data.y;
                break;
            case 'positionUpdate':
                currentPosition.x = data.x;
                currentPosition.y = data.y;
                break;
            case 'gameOver':
                console.log(`\n🏁 PARTIDA FINALITZADA (ID: ${data.gameId})`);
                console.log(`📏 Distància recorreguda: ${data.distance}`);
                console.log(`⏱️ Durada: ${new Date(data.startTime).toLocaleTimeString()} - ${new Date(data.endTime).toLocaleTimeString()}`);
                console.log('🔁 Mou-te per iniciar una nova partida.');
                break;
            case 'error':
                console.warn(`⚠️ Error del servidor: ${data.message}`);
                break;
            default:
                console.log('❓ Missatge no reconegut:', data);
        }
    } catch (error) {
        console.error('💥 Error processant missatge del servidor:', error);
        console.log('📨 Missatge rebut (raw):', message.toString());
    }
    displayPosition();
});

ws.on('close', (code, reason) => {
    try {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
    } catch (e) {}
    console.log(`\n🔒 Connexió tancada. Codi: ${code}. Motiu: ${reason?.toString() || 'no especificat'}`);
    process.exit(0);
});

ws.on('error', (error) => {
    try {
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
    } catch (e) {}
    console.error('❌ Error de WebSocket:', error.message);
    if (error.code === 'ECONNREFUSED') {
        console.error(`🚫 No s'ha pogut establir connexió amb ${SERVER_URL}. Assegura’t que el servidor està en funcionament.`);
    }
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Interrupció manual rebuda (SIGINT). Tancant connexió...');
    ws.close();
});
