export const acctPk = (acctId: string) => `ACCT#${acctId}`;
export const sessSk = (sessId: string) => `SESS#${sessId}`;
export const sessPk = (sessId: string) => `SESS#${sessId}`;
export const chunkSk = (seq: number) => `CHUNK#${String(seq).padStart(6, "0")}`;
export const whookSk = (whookId: string) => `WHOOK#${whookId}`;
export const evtSk = (evtId: string) => `EVT#${evtId}`;
export const rateSk = (minute: number) => `RATE#${minute}`;
