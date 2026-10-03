import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'todos' },
  { path: 'todos', loadComponent: () => import('./todos/todos-page').then((m) => m.TodosPage) },
];
