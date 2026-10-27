import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();
    const { status, message } = this.resolve(exception);
    res.status(status).json({ statusCode: status, message, error: STATUS_TEXT[status] ?? 'Error' });
  }

  private resolve(exception: unknown): { status: number; message: string | string[] } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let message: string | string[] =
        typeof body === 'string' ? body : ((body as { message?: string | string[] }).message ?? exception.message);
      if (status === 404 && typeof message === 'string' && message.startsWith('Cannot ')) message = 'Ruta no encontrada';
      if (status === 429) message = 'Demasiadas solicitudes, intente nuevamente en un minuto';
      if (status === 401 && message === 'Unauthorized') message = 'No autenticado';
      if (status === 403 && message === 'Forbidden resource') message = 'No tiene permisos para esta acción';
      return { status, message };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return { status: HttpStatus.CONFLICT, message: 'Ya existe un registro con esos datos' };
        case 'P2025':
          return { status: HttpStatus.NOT_FOUND, message: 'Registro no encontrado' };
        case 'P2003':
          return { status: HttpStatus.CONFLICT, message: 'El registro está relacionado con otros datos' };
      }
    }

    const anyErr = exception as { type?: string; status?: number };
    if (anyErr?.type === 'entity.parse.failed') return { status: 400, message: 'JSON inválido' };
    if (anyErr?.type === 'entity.too.large') return { status: 413, message: 'Solicitud demasiado grande' };

    this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Error interno del servidor' };
  }
}
