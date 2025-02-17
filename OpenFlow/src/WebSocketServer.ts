import * as os from "os";
import * as http from "http";
import * as WebSocket from "ws";
import { WebSocketServerClient } from "./WebSocketServerClient";
import { Crypt } from "./Crypt";
import { Message } from "./Messages/Message";
import { Config } from "./Config";
import { SigninMessage, NoderedUtil, TokenUser, Base } from "@openiap/openflow-api";
import { Span } from "@opentelemetry/api";
import { Histogram, Counter, Observable } from "@opentelemetry/api-metrics"
import { Logger } from "./Logger";
import { DatabaseConnection } from "./DatabaseConnection";
import { WebServer } from "./WebServer";
const { RateLimiterMemory } = require('rate-limiter-flexible')

export class WebSocketServer {
    private static _socketserver: WebSocket.Server;
    public static _clients: WebSocketServerClient[];
    public static p_all: Observable;
    public static websocket_queue_count: Observable;
    public static websocket_queue_message_count: Counter;
    public static websocket_rate_limit: Counter;
    public static websocket_errors: Counter;
    public static websocket_messages: Histogram;
    public static websocket_connections_count: Observable;
    public static message_queue_count: Observable;
    public static mongodb_watch_count: Observable;
    public static BaseRateLimiter: any;
    public static ErrorRateLimiter: any;
    //public static total_connections_count: number = 0;
    public static total_connections_count: any = {};
    static configure(server: http.Server, parent: Span): void {
        const span: Span = Logger.otel.startSubSpan("WebSocketServer.configure", parent);
        try {
            WebSocketServer.BaseRateLimiter = new RateLimiterMemory({
                points: Config.socket_rate_limit_points,
                duration: Config.socket_rate_limit_duration,
            });
            WebSocketServer.ErrorRateLimiter = new RateLimiterMemory({
                points: Config.socket_error_rate_limit_points,
                duration: Config.socket_error_rate_limit_duration,
            });

            this._clients = [];
            this._socketserver = new WebSocket.Server({ server: server });
            this._socketserver.on("connection", async (socketObject: WebSocket, req: any): Promise<void> => {
                try {
                    var sock = new WebSocketServerClient();
                    this._clients.push(sock);
                    await sock.Initialize(socketObject, req);
                } catch (error) {
                    Logger.instanse.error(error, null);    
                }
            });
            this._socketserver.on("error", (error: Error): void => {
                Logger.instanse.error(error, null);
            });
            if (!NoderedUtil.IsNullUndefinded(Logger.otel) && !NoderedUtil.IsNullUndefinded(Logger.otel.meter)) {
                WebSocketServer.p_all = Logger.otel.meter.createObservableUpDownCounter("openflow_websocket_online_clients", {
                    description: 'Total number of online websocket clients'
                }) // "agent", "version"
                let p_all = {};
                WebSocketServer.p_all?.addCallback(res => {
                    let keys = Object.keys(p_all);
                    keys.forEach(key => {
                        p_all[key] = 0;
                    });
                    for (let i = 0; i < WebSocketServer._clients.length; i++) {
                        try {
                            const cli = WebSocketServer._clients[i];
                            if (!NoderedUtil.IsNullUndefinded(WebSocketServer.p_all)) {
                                if (!NoderedUtil.IsNullEmpty(cli.clientagent)) {
                                    if (NoderedUtil.IsNullUndefinded(p_all[cli.clientagent])) p_all[cli.clientagent] = 0;
                                    p_all[cli.clientagent] += 1;
                                } else {
                                    if (NoderedUtil.IsNullUndefinded(p_all["unknown"])) p_all["unknown"] = 0;
                                    p_all["unknown"] += 1;
                                }
                            }
                        } catch (error) {
                            Logger.instanse.error(error, null);
                        }
                    }
                    keys = Object.keys(p_all);
                    keys.forEach(key => {
                        if (p_all[key] > 0) {
                            res.observe(p_all[key], { ...Logger.otel.defaultlabels, agent: key })
                        } else {
                            res.observe(null, { ...Logger.otel.defaultlabels, agent: key })
                        }                        
                    });
                });
                WebSocketServer.websocket_queue_count = Logger.otel.meter.createObservableUpDownCounter("openflow_websocket_queue", {
                    description: 'Total number of registered queues'
                }) // "clientid"
                WebSocketServer.websocket_queue_count?.addCallback(res => {
                    if (!Config.otel_measure_queued_messages) return;
                    for (let i = 0; i < WebSocketServer._clients.length; i++) {
                        const cli: WebSocketServerClient = WebSocketServer._clients[i];
                        res.observe(cli._queues.length, { ...Logger.otel.defaultlabels, clientid: cli.id })
                    }
                });
                WebSocketServer.websocket_queue_message_count = Logger.otel.meter.createCounter("openflow_websocket_queue_message", {
                    description: 'Total number of queues messages'
                }) // "queuename"
                WebSocketServer.websocket_rate_limit = Logger.otel.meter.createCounter("openflow_websocket_rate_limit", {
                    description: 'Total number of rate limited messages'
                }) // "command"
                WebSocketServer.websocket_errors = Logger.otel.meter.createCounter("openflow_websocket_errors", {
                    description: 'Total number of websocket errors'
                }) // 
                WebSocketServer.websocket_messages = Logger.otel.meter.createHistogram('openflow_websocket_messages_duration_seconds', {
                    description: 'Duration for handling websocket requests', valueType: 1, unit: 's'
                }); // "command"
                WebSocketServer.message_queue_count = Logger.otel.meter.createObservableUpDownCounter("openflow_message_queue", {
                    description: 'Total number messages waiting on reply from client'
                }) // "clientid"
                WebSocketServer.message_queue_count?.addCallback(res => {
                    if (!Config.otel_measure_queued_messages) return;
                    for (let i = 0; i < WebSocketServer._clients.length; i++) {
                        const cli: WebSocketServerClient = WebSocketServer._clients[i];
                        const keys = Object.keys(cli.messageQueue);
                        res.observe(keys.length, { ...Logger.otel.defaultlabels, clientid: cli.id })
                    }
                });
                WebSocketServer.mongodb_watch_count = Logger.otel.meter.createObservableUpDownCounter("mongodb_watch", {
                    description: 'Total number af steams  watching for changes'
                }) // "agent", "clientid"
                WebSocketServer.mongodb_watch_count?.addCallback(res => {
                    if (!Config.otel_measure__mongodb_watch) return;
                    if (NoderedUtil.IsNullUndefinded(WebSocketServer.mongodb_watch_count)) return;
                    const result: any = {};
                    let total: number = 0;
                    for (let i = WebSocketServer._clients.length - 1; i >= 0; i--) {
                        const cli: WebSocketServerClient = WebSocketServer._clients[i];
                        const keys = Object.keys(cli.watches);
                        res.observe(keys.length, { ...Logger.otel.defaultlabels, clientid: cli.id, agent: cli.clientagent })
                    }
                });
                WebSocketServer.websocket_connections_count = Logger.otel.meter.createObservableUpDownCounter('openflow_websocket_connections_count', {
                    description: 'Total number of connection requests'
                }); // "command"
                WebSocketServer.websocket_connections_count?.addCallback(res => {
                    const keys = Object.keys(this.total_connections_count);
                    keys.forEach(key => {
                        key = key.split(":").join("-");
                        res.observe(this.total_connections_count[key], { ...Logger.otel.defaultlabels, remoteip: key })
                    });
                });
            }
            setTimeout(this.pingClients.bind(this), Config.ping_clients_interval);
        } catch (error) {
            Logger.instanse.error(error, span);
            return;
        } finally {
            Logger.otel.endSpan(span);
        }

    }
    public static async DumpClients(parent: Span): Promise<void> {
        try {
            const jwt = Crypt.rootToken();
            const hostname = (Config.getEnv("HOSTNAME", undefined) || os.hostname()) || "unknown";
            const clients: Base[] = [];
            for (let i = WebSocketServer._clients.length - 1; i >= 0; i--) {
                const cli: WebSocketServerClient = WebSocketServer._clients[i];
                var c: any = {};
                c._type = "websocketclient";
                c.api = hostname;
                c.id = cli.id;
                c.clientagent = cli.clientagent;
                c.clientversion = cli.clientversion;
                c._exchanges = cli._exchanges;
                c._queues = cli._queues;
                c.lastheartbeat = cli.lastheartbeat;
                c.created = cli.created;
                c.remoteip = cli.remoteip;
                c.user = cli.user;
                c.username = cli.username;
                c.watches = cli.watches;
                if (NoderedUtil.IsNullEmpty(c.username)) c.username = "";
                if (NoderedUtil.IsNullEmpty(c.clientagent)) c.clientagent = "";
                if (NoderedUtil.IsNullEmpty(c.id)) c.id = "";
                c.name = (c.username + "/" + c.clientagent + "/" + c.id).trim();
                clients.push(c);
            }
            Logger.instanse.info("Insert " + clients.length + " clients", parent);
            await Config.db.InsertMany(clients, "websocketclients", 1, false, jwt, parent)
        } catch (error) {
            Logger.instanse.error(error, parent);
        }
    }
    private static lastUserUpdate = Date.now();
    private static async pingClients(): Promise<void> {
        const span: Span = (Config.otel_trace_pingclients ? Logger.otel.startSpan("WebSocketServer.pingClients", null, null) : null);
        try {
            let count: number = WebSocketServer._clients.length;
            for (let i = WebSocketServer._clients.length - 1; i >= 0; i--) {
                const cli: WebSocketServerClient = WebSocketServer._clients[i];
                try {
                    if (!NoderedUtil.IsNullEmpty(cli.jwt)) {
                        try {
                            const payload = Crypt.decryptToken(cli.jwt);
                            const clockTimestamp = Math.floor(Date.now() / 1000);
                            if ((payload.exp - clockTimestamp) < 60) {
                                Logger.instanse.debug("Token for " + cli.id + "/" + cli.user.name + "/" + cli.clientagent + "/" + cli.remoteip + " expires in less than 1 minute, send new jwt to client", span);
                                const tuser: TokenUser = await Message.DoSignin(cli, null, span);
                                if (tuser != null) {
                                    span?.addEvent("Token for " + cli.id + "/" + cli.user.name + "/" + cli.clientagent + "/" + cli.remoteip + " expires in less than 1 minute, send new jwt to client");
                                    const l: SigninMessage = new SigninMessage();
                                    cli.jwt = Crypt.createToken(tuser, Config.shorttoken_expires_in);
                                    l.jwt = cli.jwt;
                                    l.user = tuser;
                                    const m: Message = new Message(); m.command = "refreshtoken";
                                    m.data = JSON.stringify(l);
                                    cli.Send(m);
                                } else {
                                    cli.Close(span);
                                }
                            }
                        } catch (error) {
                            try {
                                Logger.instanse.debug(cli.id + "/" + cli.user?.name + "/" + cli.clientagent + "/" + cli.remoteip + " ERROR: " + (error.message || error), span);
                                if (cli != null) cli.Close(span);
                            } catch (error) {                                
                            }
                        }
                    } else {
                        const now = new Date();
                        const seconds = (now.getTime() - cli.created.getTime()) / 1000;
                        if (seconds >= Config.client_signin_timeout) {
                            if (cli.user != null) {
                                span?.addEvent("client " + cli.id + "/" + cli.user.name + "/" + cli.clientagent + "/" + cli.remoteip + " did not signin in after " + seconds + " seconds, close connection");
                                Logger.instanse.debug("client " + cli.id + "/" + cli.user.name + "/" + cli.clientagent + "/" + cli.remoteip + " did not signin in after " + seconds + " seconds, close connection", span);
                            } else {
                                span?.addEvent("client not signed/" + cli.id + "/" + cli.clientagent + "/" + cli.remoteip + " did not signin in after " + seconds + " seconds, close connection");
                                Logger.instanse.debug("client not signed/" + cli.id + "/" + cli.clientagent + "/" + cli.remoteip + " did not signin in after " + seconds + " seconds, close connection", span);
                            }
                            cli.Close(span);
                        }
                    }
                } catch (error) {
                    Logger.instanse.error(error, span);
                    cli.Close(span);
                }
                const now = new Date();
                const seconds = (now.getTime() - cli.lastheartbeat.getTime()) / 1000;
                cli.lastheartbeatsec = seconds.toString();
                if (seconds >= Config.client_heartbeat_timeout) {
                    if (cli.user != null) {
                        span?.addEvent("client " + cli.id + "/" + cli.user.name + "/" + cli.clientagent + "/" + cli.remoteip + " timeout, close down");
                        Logger.instanse.debug("client " + cli.id + "/" + cli.user.name + "/" + cli.clientagent + "/" + cli.remoteip + " timeout, close down", span);
                    } else {
                        span?.addEvent("client not signed/" + cli.id + "/" + cli.clientagent + "/" + cli.remoteip + " timeout, close down");
                        Logger.instanse.debug("client not signed/" + cli.id + "/" + cli.clientagent + "/" + cli.remoteip + " timeout, close down", span);
                    }
                    cli.Close(span);
                }
                cli.ping(span);
                if (!cli.connected() && cli.queuecount() == 0) {
                    if (cli.user != null) {
                        Logger.instanse.debug("removing disconnected client " + cli.id + "/" + cli.user.name + "/" + cli.clientagent + "/" + cli.remoteip, span);
                        span?.addEvent("removing disconnected client " + cli.id + "/" + cli.user.name + "/" + cli.clientagent + "/" + cli.remoteip);
                    } else {
                        Logger.instanse.debug("removing disconnected client " + cli.id + "/" + cli.clientagent + "/" + cli.remoteip, span);
                        span?.addEvent("removing disconnected client " + cli.id + "/" + cli.clientagent + "/" + cli.remoteip);
                    }
                    try {
                        cli.Close(span)
                        if (cli._socketObject == null || cli._socketObject.readyState === cli._socketObject.CLOSED) {
                            WebSocketServer._clients.splice(i, 1);
                        } else {
                            Logger.instanse.silly("Not ready to remove client yet " + cli.id + "/" + cli.clientagent + "/" + cli.remoteip, span);
                        }
                    } catch (error) {
                        Logger.instanse.error(error, span);
                    }
                }
            }
            if (count !== WebSocketServer._clients.length) {
                Logger.instanse.debug("new client count: " + WebSocketServer._clients.length, span);
                span?.setAttribute("clientcount", WebSocketServer._clients.length)
            }
            const p_all = {};
            const bulkUpdates = [];
            for (let i = 0; i < WebSocketServer._clients.length; i++) {
                try {
                    const cli = WebSocketServer._clients[i];
                    if (cli.user != null) {
                        if (!NoderedUtil.IsNullEmpty(cli.clientagent)) {
                            if (!NoderedUtil.IsNullUndefinded(WebSocketServer.p_all)) {
                                if (NoderedUtil.IsNullUndefinded(p_all[cli.clientagent])) p_all[cli.clientagent] = 0;
                                p_all[cli.clientagent] += 1;
                            }
                        }
                        var updateDoc = Logger.DBHelper.UpdateHeartbeat(cli);
                        if (updateDoc != null) {
                            bulkUpdates.push({
                                updateOne: {
                                    filter: { _id: cli.user._id },
                                    update: updateDoc
                                }
                            });
                        }
                    }
                } catch (error) {
                    Logger.instanse.error(error, span);
                }
            }

            if (bulkUpdates.length > 0) {
                this.lastUserUpdate = Date.now();
                let ot_end: any = Logger.otel.startTimer();
                var bulkresult = await Config.db.db.collection("users").bulkWrite(bulkUpdates);
                Logger.otel.endTimer(ot_end, DatabaseConnection.mongodb_updatemany, { collection: "users" });
            }
        } catch (error) {
            Logger.instanse.error(error, span);
        } finally {
            Logger.otel.endSpan(span);
            setTimeout(this.pingClients.bind(this), Config.ping_clients_interval);
        }
    }
}