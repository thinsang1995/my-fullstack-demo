import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Todo } from './todo.entity';

@Injectable()
export class TodoService {
  constructor(
    @InjectRepository(Todo)
    private readonly todoRepo: Repository<Todo>,
  ) {}

  findAll(): Promise<Todo[]> {
    return this.todoRepo.find({ order: { createdAt: 'DESC' } });
  }

  create(title: string): Promise<Todo> {
    const todo = this.todoRepo.create({ title });
    return this.todoRepo.save(todo);
  }

  async toggleComplete(id: string): Promise<Todo> {
    const todo = await this.todoRepo.findOneBy({ id });
    if (!todo) throw new NotFoundException();
    todo.completed = !todo.completed;
    return this.todoRepo.save(todo);
  }

  async remove(id: string): Promise<void> {
    const result = await this.todoRepo.delete(id);
    if (result.affected === 0) throw new NotFoundException();
  }
}
