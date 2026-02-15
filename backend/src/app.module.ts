import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TodoModule } from './todo/todo.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('DB_HOST', '/cloudsql/project-63c91435-bad0-420c-859:asia-northeast1:demo-db'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get('DB_USER', 'demo-user'),
        password: config.get('DB_PASS', 'DemoPass123!'),
        database: config.get('DB_NAME', 'demo_prod'),
        extra: config.get('DB_HOST', '').startsWith('/cloudsql')
          ? { socketPath: config.get('DB_HOST') }
          : {},
        autoLoadEntities: true,
        synchronize: config.get('NODE_ENV') !== 'production',
      }),
    }),
    TodoModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
