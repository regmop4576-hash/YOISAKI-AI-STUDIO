export class AppError extends Error{constructor(code,message,status=400){super(message);this.code=code;this.status=status}}
export const fail=(code,message,status=400)=>{throw new AppError(code,message,status)};
export function publicError(e){return e instanceof AppError?{error:e.message,code:e.code}:{error:'Внутренняя ошибка. Проверьте свободное место и diagnostics.sh.',code:'LOCAL_ERROR'}}
