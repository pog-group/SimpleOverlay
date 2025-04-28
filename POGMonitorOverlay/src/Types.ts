


export type LCUDatas = {
    connected?: boolean;
    address: string;
    port: number;
    username: string;
    password: string;
    protocol: string;
}

export type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD" | "CONNECT"


export type draftTurnType = "ban" | "pick" | unknown
export type TLCU_action = {
    "actorCellId": number,
    "championId": number,
    "completed": boolean,
    "id": number,
    "isAllyAction": boolean,
    "isInProgress": boolean,
    "pickTurn": number,
    "type": draftTurnType
  }