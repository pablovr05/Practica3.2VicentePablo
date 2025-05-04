require('dotenv').config();
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'websocket-game-server' },
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'server.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ],
});

const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017';
const dbName = process.env.DB_NAME || 'gameData';
const collectionName = process.env.COLLECTION || 'movementData';
let db;
let movementsCollection;

async function connectDB() {
    try {
        const client = new MongoClient(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true });
        await client.connect();
        db = client.db(dbName);
        movementsCollection = db.collection(collectionName);
        logger.info(`Conexión establecida con MongoDB en ${mongoUrl}, base de datos: ${dbName}`);
    } catch (err) {
        logger.error('Error al conectar con MongoDB:', err);
        process.exit(1);
    }
}

const PORT = process.env.PORT || 1234;
const wss = new WebSocket.Server({ port: PORT });
const clients = new Map();
const INACTIVITY_TIMEOUT = process.env.INACTIVITY_TIMEOUT || 10000;

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    logger.info(`Nuevo cliente conectado: ${clientId}`);

    clients.set(ws, {
        clientId: clientId,
        currentGameId: null,
        startPosition: null,
        currentPosition: { x: 0, y: 0 },
        lastPosition: null,
        lastMoveTime: null,
        inactivityTimer: null,
        gameStartTime: null
    });

    try {
        const initialState = clients.get(ws);
        ws.send(JSON.stringify({ type: 'initialState', x: initialState.currentPosition.x, y: initialState.currentPosition.y }));
    } catch (sendError) {
        logger.error(`Error al enviar estado inicial al cliente ${clientId}: ${sendError.message}`);
    }

    const endGame = (wsClient) => {
        const clientState = clients.get(wsClient);
        if (!clientState || !clientState.currentGameId) {
            return;
        }
        clearTimeout(clientState.inactivityTimer);
        const { currentGameId, startPosition, lastPosition, gameStartTime, clientId: cId } = clientState;
        let distance = 0;
        if (startPosition && lastPosition) {
            distance = Math.sqrt(
                Math.pow(lastPosition.x - startPosition.x, 2) +
                Math.pow(lastPosition.y - startPosition.y, 2)
            );
            logger.info(`Partida finalizada por inactividad. Juego: ${currentGameId}, Cliente: ${cId}. Posición inicial: (${startPosition.x},${startPosition.y}), final: (${lastPosition.x},${lastPosition.y}), distancia: ${distance.toFixed(2)}`);
        } else if (startPosition) {
            logger.info(`Partida finalizada por inactividad justo después de comenzar. Juego: ${currentGameId}, Cliente: ${cId}. Distancia: 0`);
            distance = 0;
        } else {
            logger.warn(`Partida finalizada sin posición inicial registrada. Juego: ${currentGameId}, Cliente: ${cId}. No se puede calcular la distancia.`);
        }

        try {
            wsClient.send(JSON.stringify({
                type: 'gameOver',
                gameId: currentGameId,
                distance: distance.toFixed(2),
                startTime: gameStartTime,
                endTime: new Date()
            }));
        } catch (sendError) {
            logger.error(`Error al enviar mensaje 'gameOver' al cliente ${cId}: ${sendError.message}`);
        }

        clientState.currentGameId = null;
        clientState.startPosition = null;
        clientState.lastPosition = null;
        clientState.currentPosition = { x: 0, y: 0 };
        clientState.lastMoveTime = null;
        clientState.inactivityTimer = null;
        clientState.gameStartTime = null;

        try {
            wsClient.send(JSON.stringify({
                type: 'positionUpdate',
                x: clientState.currentPosition.x,
                y: clientState.currentPosition.y
            }));
        } catch (sendError) {
            logger.error(`Error al enviar posición restablecida tras finalizar la partida al cliente ${cId}: ${sendError.message}`);
        }
    };

    ws.on('message', async (message) => {
        const clientState = clients.get(ws);
        if (!clientState) {
            logger.error("Se recibió un mensaje de un cliente no registrado.");
            return;
        }
        const { clientId: cId } = clientState;

        try {
            const rawMessage = message.toString();
            const data = JSON.parse(rawMessage);
            if (typeof data.command !== 'string') {
                throw new Error("Formato de mensaje inválido. Falta la propiedad 'command'.");
            }
            const command = data.command;
            logger.info(`Comando recibido de cliente ${cId}: ${command}`);
            const now = Date.now();
            const currentTime = new Date();

            if (!clientState.currentGameId) {
                clientState.currentGameId = `G_${now}_${cId.substring(0, 4)}`;
                clientState.startPosition = { ...clientState.currentPosition };
                clientState.gameStartTime = currentTime;
                logger.info(`Inicio de nueva partida. Juego: ${clientState.currentGameId}, Cliente: ${cId}, Posición inicial: (${clientState.startPosition.x},${clientState.startPosition.y})`);
            }

            let newPosition = { ...clientState.currentPosition };
            switch (command) {
                case 'up':
                    newPosition.y += 1;
                    break;
                case 'down':
                    newPosition.y -= 1;
                    break;
                case 'left':
                    newPosition.x -= 1;
                    break;
                case 'right':
                    newPosition.x += 1;
                    break;
                default:
                    logger.warn(`Comando no reconocido recibido del cliente ${cId}: ${command}`);
                    try {
                        ws.send(JSON.stringify({ type: 'error', message: `Comando no reconocido: ${command}` }));
                    } catch (sendError) {
                        logger.error(`Error al enviar mensaje de error de comando al cliente ${cId}: ${sendError.message}`);
                    }
                    return;
            }

            clientState.currentPosition = newPosition;
            clientState.lastPosition = { ...newPosition };
            clientState.lastMoveTime = now;

            const movementData = {
                gameId: clientState.currentGameId,
                clientId: cId,
                command: command,
                x: newPosition.x,
                y: newPosition.y,
                timestamp: currentTime
            };

            try {
                if (!movementsCollection) {
                    logger.error(`Error: colección de movimientos no inicializada para el cliente ${cId}.`);
                    return;
                }
                await movementsCollection.insertOne(movementData);
            } catch (dbErr) {
                logger.error(`Error al guardar el movimiento en la base de datos. Juego: ${clientState.currentGameId}, Cliente: ${cId}: ${dbErr}`);
            }

            try {
                ws.send(JSON.stringify({
                    type: 'positionUpdate',
                    x: newPosition.x,
                    y: newPosition.y
                }));
                logger.info(`Posición actualizada enviada al cliente ${cId}: (${newPosition.x}, ${newPosition.y})`);
            } catch (sendError) {
                logger.error(`Error al enviar 'positionUpdate' al cliente ${cId}: ${sendError.message}`);
            }

            clearTimeout(clientState.inactivityTimer);
            clientState.inactivityTimer = setTimeout(() => {
                logger.warn(`Se detectó inactividad en el cliente ${cId}. Finalizando partida.`);
                endGame(ws);
            }, INACTIVITY_TIMEOUT);

        } catch (error) {
            logger.error(`Error procesando el mensaje del cliente ${cId}: ${error.message}. Mensaje original: ${message.toString()}`);
            try {
                ws.send(JSON.stringify({ type: 'error', message: 'Ocurrió un error procesando tu comando.' }));
            } catch (sendError) {
                logger.error(`Error al enviar mensaje de error general al cliente ${cId}: ${sendError.message}`);
            }
        }
    });

    ws.on('close', () => {
        const clientState = clients.get(ws);
        if (clientState) {
            logger.info(`Cliente desconectado: ${clientState.clientId}`);
            if (clientState.inactivityTimer) {
                clearTimeout(clientState.inactivityTimer);
            }
            clients.delete(ws);
        } else {
            logger.warn("Un cliente no registrado se ha desconectado.");
        }
    });

    ws.on('error', (error) => {
        const clientState = clients.get(ws);
        const cId = clientState ? clientState.clientId : 'desconocido';
        logger.error(`Error en WebSocket del cliente ${cId}: ${error.message}`);
        if (clientState && clientState.inactivityTimer) {
            clearTimeout(clientState.inactivityTimer);
        }
        if (clientState) {
            clients.delete(ws);
        }
    });
});

async function startServer() {
    await connectDB();
    if (db && movementsCollection) {
        logger.info(`Servidor WebSocket iniciado correctamente en el puerto ${PORT}`);
    } else {
        logger.error("No se pudo iniciar el servidor WebSocket debido a un error en la base de datos.");
        process.exit(1);
    }
}

startServer();

process.on('SIGINT', () => {
    logger.info("Se recibió la señal SIGINT. Cerrando el servidor...");
    wss.close(() => {
        logger.info("Servidor WebSocket cerrado correctamente.");
        process.exit(0);
    });
});
