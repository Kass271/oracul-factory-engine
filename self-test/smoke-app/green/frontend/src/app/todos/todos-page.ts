import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatSnackBar } from '@angular/material/snack-bar';

import { Todo } from '../api/models/todo';
import { TodosService } from '../api/services/todos.service';

@Component({
  selector: 'app-todos-page',
  imports: [MatButtonModule, MatFormFieldModule, MatInputModule, MatListModule],
  templateUrl: './todos-page.html',
})
export class TodosPage {
  private readonly api = inject(TodosService);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly todos = signal<Todo[]>([]);
  protected readonly title = signal('');

  constructor() {
    this.api.listTodos().subscribe({
      next: (todos) => this.todos.set(todos),
      error: () => this.snackBar.open('Could not load todos', 'OK'),
    });
  }

  protected add(): void {
    this.api.createTodo({ body: { title: this.title().trim() } }).subscribe({
      next: (todo) => {
        this.todos.update((list) => [...list, todo]);
        this.title.set('');
      },
      error: (e) => this.snackBar.open(e?.error?.message ?? 'Could not add the todo', 'OK'),
    });
  }
}
