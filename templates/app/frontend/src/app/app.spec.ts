import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { App } from './app';

describe('App shell', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('shows the backend status from the ping endpoint', async () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);

    http.expectOne((req) => req.url.endsWith('/api/ping')).flush({ message: 'pong' });
    await fixture.whenStable();

    const status = fixture.nativeElement.querySelector('[data-testid="backend-status"]');
    expect(status.textContent).toContain('pong');
  });
});
