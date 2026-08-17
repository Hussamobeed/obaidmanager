export async function sha256(value:string){const bytes=new TextEncoder().encode(value);const digest=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(digest)).map((x)=>x.toString(16).padStart(2,"0")).join("")}
export function randomToken(){const bytes=crypto.getRandomValues(new Uint8Array(32));return Array.from(bytes).map((x)=>x.toString(16).padStart(2,"0")).join("")}
