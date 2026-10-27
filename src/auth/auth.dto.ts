import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'El email no es válido' })
  email!: string;

  @IsString({ message: 'La contraseña es requerida' })
  @IsNotEmpty({ message: 'La contraseña es requerida' })
  password!: string;
}

export class RefreshTokenDto {
  @IsString({ message: 'refreshToken es requerido' })
  @IsNotEmpty({ message: 'refreshToken es requerido' })
  refreshToken!: string;
}
