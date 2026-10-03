import { Component, inject, signal } from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterOutlet } from '@angular/router';

import { SystemService } from './api/services/system.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, MatToolbarModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly system = inject(SystemService);
  protected readonly title = '{{APP_TITLE}}';
  protected readonly backendStatus = signal('checking…');

  constructor() {
    this.system.ping().subscribe({
      next: (p) => this.backendStatus.set(p.message),
      error: () => this.backendStatus.set('unreachable'),
    });
  }
}
