export class AppError extends Error{constructor(code,message,status=400){super(message);this.code=code;this.status=status}}
export const fail=(code,message,status=400)=>{throw new AppError(code,message,status)};
// v1.7.7: an AppError may carry public, credential-free details (e.g. alternative GPU offers after a refused creation).
export const failWith=(code,message,status=400,details=null)=>{const e=new AppError(code,message,status);if(details)e.details=details;throw e};
export function publicError(e){return e instanceof AppError?{error:e.message,code:e.code,...(e.details?{details:e.details}:{})}:{error:'Внутренняя ошибка. Проверьте свободное место и diagnostics.sh.',code:'LOCAL_ERROR'}}
